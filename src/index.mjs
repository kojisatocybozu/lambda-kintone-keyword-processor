import axios from "axios";

import {
  LambdaClient,
  InvokeCommand
} from "@aws-sdk/client-lambda";

const APP_ID = "936";
const STATUS_FIELD = "KeywordExtractionStatus";
const DATE_FIELD = "KeywordExtractionDate";
const ERROR_FIELD = "KeywordExtractionError";

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

  try {
    return axios.create({
      baseURL: `${baseURL.replace(/\/$/, "")}/k/v1`,
      headers: {
        "X-Cybozu-API-Token": token
      },
      timeout: 60000
    });
  } catch (error) {
    console.error("HTTPリクエストエラー:", {
      message: error.message,
      status: error.response?.status,
      responseData: error.response?.data,
      requestUrl: error.config?.url,
      method: error.config?.method,
    });
    throw error;
  }
}

async function markError(client, recordId, message) {
  try {
    await client.put("/record.json", {
      app: APP_ID,
      id: recordId,
      record: {
        [STATUS_FIELD]: { value: "エラー" },
        [DATE_FIELD]: { value: new Date().toISOString() },
        [ERROR_FIELD]: {
          value: String(message).slice(0, 5000)
        }
      }
    });
  } catch (error) {
    console.error(
      `レコード ${recordId} のエラー状態保存に失敗:`,
      error.message
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

  // 抽出Lambdaは処理失敗時に statusCode: 500 を返す
  if (result.statusCode >= 400) {
    let body = result.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // JSONとして読めない場合は元の本文を利用
      }
    }

    throw new Error(
      body?.error || `抽出Lambdaが失敗しました: ${result.statusCode}`
    );
  }

  return result;
}

export const handler = async () => {
  if (!EXTRACTOR_NAME) {
    throw new Error("EXTRACTOR_FUNCTION_NAME が未設定です");
  }

  const client = getKintoneClient();


  let response;

  try {
    response = await client.get("/records.json", {
      params: {
        app: APP_ID,
        query: `${STATUS_FIELD} in ("依頼中") order by $id asc limit 3`
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

  console.log(`今回の処理対象: ${records.length}件`);

  const results = [];

  for (const record of records) {
    const recordId = record.$id.value;

    try {
      console.log(`抽出開始: recordId=${recordId}`);

      const result = await invokeExtractor(recordId);

      console.log(`抽出成功: recordId=${recordId}`);

      results.push({
        recordId,
        success: true,
        filesProcessed: JSON.parse(result.body).filesProcessed
      });
    } catch (error) {
      console.error(
        `抽出失敗: recordId=${recordId}`,
        error.message
      );

      // 抽出Lambda側ですでに記録済みでも、
      // 呼び出しエラー時に状態を確実に残すため再記録する
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
      processed: results.length,
      results
    })
  };
};