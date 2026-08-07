# Domain Docs

How engineering skills should consume this repository’s domain documentation.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- `CONTEXT-MAP.md` if it exists; it points to context-specific documentation.
- Relevant ADRs under `docs/adr/`.

If these files do not exist, proceed silently. Domain-modeling skills create them lazily when terminology or architectural decisions are resolved.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
└── docs/
    └── adr/
```

## Use the glossary’s vocabulary

When naming a domain concept in an issue, refactor proposal, hypothesis, or test, use the term defined in `CONTEXT.md`. Avoid synonyms the glossary explicitly rejects.

If a needed concept is absent, reconsider whether the terminology fits the project or record the gap for domain modeling.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly instead of silently overriding it.
