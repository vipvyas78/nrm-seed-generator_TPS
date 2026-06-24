"""TPS FastAPI application — tender preparation utilities and integrations."""

from __future__ import annotations

from fastapi import FastAPI

from api.routers import tender_prep

app = FastAPI(
    title="BuildFlow TPS API",
    version="0.1.0",
    description="Tender Preparation & Submission — workflow utilities and BOQ integration",
)

app.include_router(tender_prep.router, prefix="/tender-prep", tags=["Tender Prep"])


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "tps-api"}
