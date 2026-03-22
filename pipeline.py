from langgraph.graph import StateGraph, START, END
from state import NoteState
from nodes import intake_extractor, uncertainty_searcher, visual_generator, draft_writer, reflector, finalize


def should_revise(state: NoteState) -> str:
    scores = state.get("reflection_scores")
    loop_count = state.get("loop_count", 0)
    if scores and not scores.get("good_enough", True) and loop_count < 2:
        return "revise"
    return "finalize"


def build_graph():
    builder = StateGraph(NoteState)

    builder.add_node("intake_extractor", intake_extractor)
    builder.add_node("uncertainty_searcher", uncertainty_searcher)
    builder.add_node("visual_generator", visual_generator)
    builder.add_node("draft_writer", draft_writer)
    builder.add_node("reflector", reflector)
    builder.add_node("finalize", finalize)

    builder.add_edge(START, "intake_extractor")
    builder.add_edge("intake_extractor", "uncertainty_searcher")
    builder.add_edge("uncertainty_searcher", "visual_generator")
    builder.add_edge("visual_generator", "draft_writer")
    builder.add_edge("draft_writer", "reflector")
    builder.add_conditional_edges("reflector", should_revise, {
        "revise": "draft_writer",
        "finalize": "finalize"
    })
    builder.add_edge("finalize", END)

    return builder.compile()

graph = build_graph()
