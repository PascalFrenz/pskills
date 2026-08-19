---
name: iterative-diagram
description: "Design a diagram with the user one small increment at a time, in mermaid in the chat, instead of dumping a finished picture. Use when the user wants to model, map, or draw an architecture, a flow, a class model, or a state machine, when they ask to extend or correct an existing diagram, or when they say a diagram is too big to review."
---

# Iterative diagram

A diagram is reviewed by a human, and a human can only check a few things at a
time. A large diagram delivered in one turn cannot be reviewed, only accepted or
rejected. So build it in increments small enough to be judged, and keep the
whole thing in the chat where it costs nothing to redraw.

## The loop

1. **Plan the increments first.** Write a numbered backlog of increments before
   drawing anything, and show it. It tells the user where this is going and lets
   them reorder it. Keep it visible as you work.
2. **Draw one increment.** Obey the budget below.
3. **Ask exactly one question**, about the increment you just drew. Then stop.
4. **Apply the answer**, redraw, repeat.

Never continue to the next increment without an answer. The point of the loop
is the answer, not the drawing.

## Budget per increment

- At most **5 new boxes**.
- At most **3 changes** to what already exists.
- At most **1 question** per turn.

If a request needs more than that, split it and say which part you are doing
first. A user who asks for "the whole ingress side" is describing a backlog
item, not an increment.

## One artifact

There is **one diagram**, and every turn re-emits it whole. Never send a
fragment, a diff, or a "here is just the new part" — the user must always be
able to read the current state in the newest message without scrolling back and
merging versions in their head.

When several views are genuinely needed (see below), that set is the artifact:
re-emit all of them, every turn.

## Mermaid first, always

Draw in **mermaid, in the chat**. It renders immediately, it costs nothing to
throw away, and it keeps the review in one place.

Only after the user approves the shape, port it to the heavyweight format
(draw.io, Excalidraw, a committed `.svg`) as the final step. Porting early
means every increment pays the export cost, and the user starts defending a
diagram because it looks finished.

If an existing draw.io or image diagram is the starting point, redraw it in
mermaid first and leave the original untouched until the port.

## Styling

High contrast, no decoration:

```
classDef box fill:#ffffff,stroke:#000000,stroke-width:1px,color:#000000
```

Black on white, reversed for a dark theme. Mark what changed this increment
with **stroke weight**, not fill colour — fill is the first thing that becomes
unreadable in the other theme, and the marking is temporary anyway.

## Picking the diagram type

Ask what question the diagram must answer, then pick:

| Question | Type |
| --- | --- |
| What talks to what, in what order? | `sequenceDiagram` |
| What are the types and how do they relate? | `classDiagram` |
| What are the packages and their dependencies? | `C4Component` |
| What is the runtime path? | `flowchart` |
| What are the states and transitions? | `stateDiagram-v2` |

A sequence diagram usually beats a flowchart for a request flow: it forces the
actors and the ordering to be explicit, and it exposes who initiates a call.

One type rarely answers everything. A common stable set is **three views**:
a C4 component view for package boundaries, a class diagram for structure, and
a sequence diagram for flow. Lock the set with the user, then re-emit all three
each turn.

## Renderer limits worth knowing

Verified in a Copilot CLI chat window; probe before relying on them elsewhere.

- **`classDiagram` cannot draw package boxes.** `namespace` is its only
  grouping primitive and it renders flat, with or without dots in the name.
  Fall back to a `<<stereotype>>` line naming the package inside each class box.
- **`C4Component` does draw real boundary boxes**, so use it when package
  structure is the point. It has no inheritance or implements notation, so
  those become labelled relations.
- **`flowchart` `subgraph` gives real nested boxes**, so it is the fallback when
  you need both grouping and freeform node text.
- When a construct renders flat or not at all, **probe it with a three-line
  example** rather than rewriting the whole artifact against a guess.

## Do not

- Do not deliver a finished diagram in the first turn.
- Do not batch several questions and wait for one reply.
- Do not silently switch to a second diagram when the user asked to extend the
  first. One artifact, unless they say otherwise.
- Do not add a box the user did not ask for because it "belongs there". Propose
  it as the question instead.
