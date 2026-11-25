# Milestone 6 test report
Base 04c8e8c, Linux. Nothing committed or pushed.
Moves of boxes over a whole run (old -> new): bst 22->18, avl rotations 16->15, n-ary tree 90->26 (worst step 13->5). Graph runs (old layout broken): graph 42, bfs 63 (old 203), 24 vertices 844 (old 1127).
Build time whole trace: noise level vs old. One scene with arrows: 25 vertices 4-11 ms, 100 vertices 24-41 ms, 200 vertices 65 ms.
Limits: tracer depth 16 / 300 objects (shows "N edges not captured"); container->vertex arrows can look busy in big graphs; shared neighbour list keeps old view; name-only dict adjacency not a graph; stability is hysteresis, not "nothing moves".
Totals: vitest 253 passed 1 skipped (12 files). Playwright full suite after final spec edit: 78 passed, 0 failed (71 old + 7 m6). BST browser test samples every 4th step (full-step movement ceilings are in vitest). tsc and vite build clean. Recordings are committed in frontend/tests/fixtures/m6/*.m6.json.
Run: cd frontend && npx vitest run; npx playwright test.
