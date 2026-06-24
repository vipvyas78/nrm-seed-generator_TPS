"""TPS backend routes — BOQ conflict resolution and SoA analysis stubs."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class ConflictAnalysis(BaseModel):
    package_id: str
    conflicts: list[dict]
    severity: str


class SoaAnalysis(BaseModel):
    workflow_id: str
    clause_refs: list[str]
    suggested_rag: list[dict]


@router.post("/conflicts/{package_id}", response_model=ConflictAnalysis)
async def analyse_conflicts(package_id: str) -> ConflictAnalysis:
    """Analyse a package's BOQ items for specification conflicts.

    TODO: Implement conflict detection by cross-referencing spec_chunks against boq_items.
    """
    raise HTTPException(status_code=501, detail="BOQ conflict analysis not yet implemented")


@router.post("/soa-suggestions/{workflow_id}", response_model=SoaAnalysis)
async def suggest_soa_rag(workflow_id: str) -> SoaAnalysis:
    """AI-assisted RAG status suggestions for SoA clauses.

    TODO: Implement using spec_mapper embeddings + NRM RAG retrieval.
    """
    raise HTTPException(status_code=501, detail="SoA RAG suggestions not yet implemented")
