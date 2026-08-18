import { NextResponse } from "next/server";
import { getPublicModelConfigs } from "../../model-config";

export async function GET() {
  const models = getPublicModelConfigs();
  return NextResponse.json({ models, configuredCount: models.filter((model) => model.configured).length });
}
