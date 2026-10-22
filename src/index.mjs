
import axios from "axios";

import {
  LambdaClient,
  InvokeCommand
} from "@aws-sdk/client-lambda";

const APP_ID = "936";
const STATUS_FIELD = "KeywordExtractionStatus";
const DATE_FIELD = "KeywordExtractionDate";
const ERROR_FIELD = "KeywordExtractionError";

const PENDING_STATUS = "依頼中";
const PROCESSING_STATUS = "処理中";
const COMPLETED_STATUS = "完了";
const FAILED_STATUS = "エラー";

const REGION = process.env.AWS_REGION || "ap-northeast-1";
const EXTRACTOR_NAME = process.env.EXTRACTOR_FUNCTION_NAME;

const lambda = new LambdaClient({ region: REGION });

function getKintoneClient() {
  const baseURL = process.env.KINTONE_BASE_URL;
  const token = process.env.KINTONE_API_TOKEN;

  if (!baseURL || !token) {
    throw new Error(
      "KINTONE_BASE_URL / KINTONE_API_TOKEN が未設定です"
    );
  }

  return axios.create({
    baseURL: `${baseURL.replace(/\/$/, "")}/k/v1`,
    headers: {
      "X-Cybozu-API-Token": token
    },
    timeout: 60000
  });
}

// レコードを「処理中」に変更して確保する。
// リビジョンが一致しなければ更新は失敗し、二重処理を防ぐ。
async function claimRecord(client, record) {
  const recordId = record.$id.value;
  const revision = record.$revision.value;

  try {
    await client.put("/record.json", {
      app: APP_ID,
      id: recordId,
      revision: Number(revision),
      record: {
        [STATUS_FIELD]: { value: PROCESSING_STATUS },
        [DATE_FIELD]: { value: new Date().toISOString() },
        [ERROR_FIELD]: { value: "" }
      }    });

    console.log(
      `レコード確保成功: recordId=${recordId}, revision=${revision}`
    );

    return true;
  } catch (error) {
    console.warn(
      `レコード確保失敗・スキップ: recordId=${recordId}`,
      {
        status: error.response?.status,
        responseData: error.response?.data,
        message: error.message
      }
    );

    // 競合、またはその他の更新エラー。
    // 確保できていないレコードは処理しない。
    return false;
  }
}

const STALE_PROCESSING_MINUTES = 30;

async function recoverStaleRecords(client) {
  const response = await client.get("/records.json", {
    params: {
      app: APP_ID,
      query:
        `${STATUS_FIELD} in ("処理中") ` +
        `order by ${DATE_FIELD} asc limit 100`
    }
  });

  const records = response.data.records || [];
  const now = Date.now();
  let recovered = 0;

  for (const record of records) {
    const recordId = record.$id.value;
    const revision = record.$revision.value;
    const dateValue = record[DATE_FIELD]?.value;

    // 開始時刻が記録されていないレコードは自動変更しない
    if (!dateValue) {
      console.warn(
        `復旧対象外: recordId=${recordId}, 開始時刻なし`
      );
      continue;
    }

    const startedAt = new Date(dateValue).getTime();

    if (!Number.isFinite(startedAt)) {
      console.warn(
        `復旧対象外: recordId=${recordId}, 開始時刻が不正`
      );
      continue;
    }

    const elapsedMinutes = (now - startedAt) / 60000;

    if (elapsedMinutes < STALE_PROCESSING_MINUTES) {
      continue;
    }

    try {
      await client.put("/record.json", {
        app: APP_ID,
        id: recordId,
        revision: Number(revision),
        record: {
          [STATUS_FIELD]: { value: "依頼中" }
        }
      });

      recovered++;

      console.log(
        `滞留レコードを依頼中に戻しました: ` +
        `recordId=${recordId}, ` +
        `経過分=${Math.floor(elapsedMinutes)}`
      );
    } catch (error) {
      // リビジョン不一致などの場合は変更せず、次のレコードへ
      console.warn(
        `滞留レコードの復旧をスキップ: recordId=${recordId}`,
        {
          status: error.response?.status,
          responseData: error.response?.data,
          message: error.message
        }
      );
    }
  }

  console.log(
    `滞留レコード復旧: 候補=${records.length}件, 復旧=${recovered}件`
  );

  return recovered;
}

async function markError(client, recordId, message) {
  try {
    await client.put("/record.json", {
      app: APP_ID,
      id: recordId,
      record: {
        [STATUS_FIELD]: {
          value: FAILED_STATUS
        },
        [DATE_FIELD]: {
          value: new Date().toISOString()
        },
        [ERROR_FIELD]: {
          value: String(message).slice(0, 5000)
        }
      }
    });
  } catch (error) {
    console.error(
      `レコード ${recordId} のエラー状態保存に失敗:`,
      error.response?.data || error.message
    );
  }
}

async function invokeExtractor(recordId) {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: EXTRACTOR_NAME,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ recordId }))
    })
  );

  const payloadText = response.Payload
    ? Buffer.from(response.Payload).toString("utf8")
    : "";

  if (response.FunctionError) {
    throw new Error(
      `抽出Lambdaの実行エラー: ${payloadText}`
    );
  }

  let result;

  try {
    result = JSON.parse(payloadText);
  } catch {
    throw new Error(
      `抽出Lambdaの応答がJSONではありません: ${payloadText}`
    );
  }

  if (result.statusCode >= 400) {
    let body = result.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // JSONでなければ本文をそのまま利用
      }
    }

    throw new Error(
      body?.error ||
      `抽出Lambdaが失敗しました: ${result.statusCode}`
    );
  }

  return result;
}

function getFilesProcessed(result) {
  if (typeof result.body !== "string") {
    return undefined;
  }

  try {
    return JSON.parse(result.body).filesProcessed;
  } catch {
    return undefined;
  }
}

export const handler = async () => {
  if (!EXTRACTOR_NAME) {
    throw new Error(
      "EXTRACTOR_FUNCTION_NAME が未設定です"
    );
  }

  const client = getKintoneClient();
  await recoverStaleRecords(client);

  let response;

  try {
    response = await client.get("/records.json", {
      params: {
        app: APP_ID,
        query:
          `${STATUS_FIELD} in ("${PENDING_STATUS}") ` +
          "order by $id asc limit 3"
      }
    });
  } catch (error) {
    console.error("kintone APIリクエストエラー:", {
      message: error.message,
      status: error.response?.status,
      responseData: error.response?.data,
      requestUrl: error.config?.url,
      method: error.config?.method
    });

    throw error;
  }

  const records = response.data.records || [];

  console.log(`今回の候補: ${records.length}件`);

  const results = [];

  for (const record of records) {
    const recordId = record.$id.value;

    // まずレコードを確保する。確保できなければ抽出しない。
    const claimed = await claimRecord(client, record);

    if (!claimed) {
      results.push({
        recordId,
        success: false,
        skipped: true,
        reason: "レコードを確保できませんでした"
      });

      continue;
    }

    try {
      console.log(`抽出開始: recordId=${recordId}`);

      const result = await invokeExtractor(recordId);

      console.log(`抽出成功: recordId=${recordId}`);

      results.push({
        recordId,
        success: true,
        filesProcessed: getFilesProcessed(result)
      });
    } catch (error) {
      console.error(
        `抽出失敗: recordId=${recordId}`,
        error.message
      );

      await markError(client, recordId, error.message);

      results.push({
        recordId,
        success: false,
        error: error.message
      });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      candidates: records.length,
      processed: results.filter(
        item => !item.skipped
      ).length,
      results
    })
  };
};