# Contributing

## Setup

1. Install Node.js 18+.
2. Clone the repository.
3. Install dependencies: `npm install`.
4. Copy `.env.example` to `.env` and fill required values.

## Development workflow

1. Create a branch from `main`.
2. Run `npm run typecheck`.
3. Run `npm run build`.
4. If you changed runtime behavior, run the local operational checks described in `README.md`.
5. Open a pull request with a clear summary and validation notes.

## Code style

- TypeScript strict mode.
- Keep changes focused and minimal.
- Do not add secrets or personal identifiers to tracked files.

## Pull requests

- Include the problem statement and the behavioral impact.
- Call out any migration or config implications.
- Ensure CI is green.
