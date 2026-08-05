"""TPS backend routes.

Empty by design, for now. The two stubs that lived here — BOQ conflict analysis and
SoA RAG suggestions — served the Employer RFIs and SoA RAG steps, which have moved to
the take-off module along with Parsed Outputs. Conflict detection in particular already
exists there (the `find_conflicts` node writes `bf_ge_conflicts`, surfaced on its own
tab), so reimplementing it here would have been a second answer to one question.

TPS's four remaining steps — Tender Launch Pack, ITT Dispatch, Comparative Analysis,
Tender Submission — are served entirely by the Fastify BFF. This router stays registered
so the service keeps a stable shape for whatever needs Python next.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()
