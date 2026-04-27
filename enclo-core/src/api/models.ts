import { ApiClient } from "./client.js";
import { ModelsResponseSchema, type Model } from "./schemas.js";

export async function listModels(client: ApiClient): Promise<Model[]> {
  const resp = await client.request("get", "v1/models", ModelsResponseSchema);
  return resp.models;
}
