# Dependencies

No paid service, API key, telemetry or remote font is required. The application fetches only its own bundled example files, its own build-time session template when you click Export, and (from M4) the backend on your own computer through `/api`. Exported session files make no network requests. npm installation and the optional browser download need internet.

Direct dependencies, license metadata checked from the installed npm packages:

| Package | Version | License | Role |
|---|---|---|---|
| react | 19.3.1 | MIT | Interface |
| react-dom | 19.3.1 | MIT | Browser rendering |
| @types/react | 19.2.14 | MIT | Development types |
| @types/react-dom | 19.2.3 | MIT | Development types |
| @types/node | 22.19.15 | MIT | Development types |
| typescript | 5.9.3 | Apache-2.0 | Type checking |
| vite | 8.3.8 | MIT | Local dev/build |
| vitest | 5.1.1 | MIT | Unit tests |
| @playwright/test | 1.65.1 | Apache-2.0 | Browser tests |

Full resolved versions are in package-lock.json. License text ships with installed packages under node_modules; inspect it before redistributing a production bundle. This file does not add or change the repository's own license.

Package records: https://www.npmjs.com/package/react , https://www.npmjs.com/package/react-dom , https://www.npmjs.com/package/typescript , https://www.npmjs.com/package/vite , https://www.npmjs.com/package/vitest , https://www.npmjs.com/package/@playwright/test .

## Backend (M4, Python)

Listed in `backend/requirements.txt`, installed with `pip install -r backend/requirements.txt`. License metadata checked from the installed packages.

| Package | Version | License | Role |
|---|---|---|---|
| fastapi | 0.162.5 | MIT | HTTP API |
| uvicorn | 0.54.0 | BSD-3-Clause | Local server |
| httpx | 0.28.1 | BSD-3-Clause | Test client only |

Their own dependencies (starlette, pydantic, anyio, h11 and others) come with them. The tests print a Starlette deprecation warning about `httpx`; it does not affect the results. No frontend package was added in M4.
