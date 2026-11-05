---
name: edd
description: Develop features from human-reviewed behavioral examples, using separate test-design, scaffolding, implementation, and review agents. Use when the human wants to develop by providing examples and tests first and leave the implementation to agents.
---

# Example-driven development

Act as coordinator. Keep the conversation with the human; delegate work to subagents. Tests in the workspace are the executable specification. No approval records, contract documents, or revision handoff files are required.

## Design examples

1. Analyze the prompt from the human. Ask for examples of the behavior to be implemented in "given/when/then" form 
 if none are provided.
2. Dispatch a test designer with [test-designer.md](references/test-designer.md), the requested behavior, and relevant repository instructions. Bring its examples and questions to the human.
3. Alternate short designer and scaffolder turns. Scaffolder skill: [scaffolder.md](references/scaffolder.md). Keep one writer active at a time. Return interface questions to the designer and human.
4. Continue until examples express the intended behavior and tests compile and fail meaningfully where behavior is missing. The human's instruction to move on starts implementation; ask no additional approval question.

## Implement and review

1. Read [code-quality.md](references/code-quality.md). Keep reports in temporary storage.
2. Dispatch an implementer with [implementer.md](references/implementer.md), the relevant test paths, and any concrete unresolved findings.
3. Dispatch a fresh reviewer with [reviewer.md](references/reviewer.md). Have it inspect the workspace and form its own assessment before considering the implementer's explanation.
4. Route implementation defects back to a fresh implementer. Route behavioral questions to the human and test designer as proposed Given/When/Then examples. Return to implementation when the human says to proceed.
5. If three repair rounds fail to resolve the same finding, present the evidence and obstacle to the human instead of repeating the loop.

All workers read the current workspace directly. Send role instructions, feature scope, relevant paths, and outstanding findings rather than conversation transcripts. The coordinator alone dispatches workers and handles human interaction; this also supports hosts without nested subagents. If delegation is unavailable, explain the limitation before claiming independent review.

## Shared boundaries

- During implementation and review, existing tests, their expectations, fixtures, snapshots, and behavior-defining helpers are read-only. Propose needed changes through test design. Preserve test discovery and execution settings.
- No skipped or disabled tests count as success. Environment failures and missing tools are incomplete checks, not passing results.
- Consult the project's README and build files for setup and test commands. Keep code quality rules and execution in this skill, outside the target project's build.
- Work in small coherent behavioral slices. Do not invoke a conflicting one-test/one-implementation TDD workflow inside this process.
- Only the designer edits tests; only the scaffolder or implementer edits production code. Reviewer experiments run in read only and never alter the shared candidate.

Completion requires passing relevant feature and regression tests with none skipped, no unresolved code quality findings within scope, and no outstanding reviewer findings. Report what actually ran and any limitations. Passing examples does not prove that all intended behavior has been specified.
