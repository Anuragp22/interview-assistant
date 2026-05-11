"""Persona definitions for the interviewer agent.

v0.1 has one Persona — the GeneralInterviewer (Sarah). Sub-project E
adds Behavioral / Technical / SystemDesign personas plus the LiveKit-
native multi-Agent supervisor scaffolding (transfer_to_<persona>
function tools). v0.1 deliberately keeps the shape so additions are
non-breaking.
"""

from __future__ import annotations

from dataclasses import dataclass


COMMON_RULES = """\
- Be transparent: this is an AI-conducted screening conversation. If asked, confirm plainly.
- Score on substance only. NEVER penalise accent, dialect, or speech patterns.
- Stay grounded in BOTH the job description and the candidate's actual CV. When the agenda
  question references something specific from the candidate's background (a project, a
  company, a tech), ask about THAT, not a generic alternative.
- When you need a concrete fact about the candidate's CV or the JD that isn't already
  obvious from the agenda question, call the `lookup_cv_jd` tool with a short query.
"""

GENERAL_TEMPLATE = """\
You are {name}, a {expertise_area}.

You are interviewing {candidate_name} for {role} ({level}).

Your interview agenda — these questions are already grounded in the candidate's CV
and the job description. Reference specifics naturally; e.g. when a question mentions
"Razorpay", you can ask about it directly without disclaiming.

{questions_block}

Tools available:
- lookup_cv_jd(query): retrieve concrete details from the candidate's CV or JD.
  Use sparingly — only when you need a specific fact you can't infer from the agenda.

Conduct rules:
{rules}
"""


@dataclass(frozen=True)
class Persona:
    """Configuration object for one interviewer persona.

    The same Persona shape ships in v0.1 (one constant — GENERAL_PERSONA)
    and grows in Sub-project E (BEHAVIORAL_PERSONA, TECHNICAL_PERSONA,
    SYSTEM_DESIGN_PERSONA), and the LiveKit Agent subclasses for E hand
    off via transfer_to_<persona> function tools — no Persona shape change.
    """

    id: str
    name: str
    expertise_area: str
    voice_id: str
    system_prompt_template: str
    rules: str


GENERAL_PERSONA = Persona(
    id="general",
    name="Sarah",
    expertise_area="general technical interviewer",
    voice_id="EXAVITQu4vr4xnSDxMaL",
    system_prompt_template=GENERAL_TEMPLATE,
    rules=COMMON_RULES,
)


def render_system_prompt(
    persona: Persona,
    candidate_name: str,
    role: str,
    level: str,
    questions_grounded: list[str],
) -> str:
    """Render the persona's template with the per-session interview data.

    Deliberately does NOT include raw CV or JD text — those live in the
    LlamaIndex vector store and are retrieved via lookup_cv_jd on demand.
    Keeps the system prompt under ~1000 tokens so attention stays sharp.
    """
    questions_block = "\n".join(
        f"{i + 1}. {q}" for i, q in enumerate(questions_grounded)
    )
    return persona.system_prompt_template.format(
        name=persona.name,
        expertise_area=persona.expertise_area,
        candidate_name=candidate_name,
        role=role,
        level=level,
        questions_block=questions_block,
        rules=persona.rules,
    )
