const ROUTES = Object.freeze({
  attendance: ["Christie AI", "Aurora", "Christie AI"],
  infrastructure: ["Christie AI", "Helios", "Christie AI"],
  "platform-operations": ["Christie AI", "Vulcan", "Aurora", "Christie AI"],
  "district-overview": ["Christie AI", "Christie AI"],
  "general-district-question": ["Christie AI", "Christie AI"]
});

export function normalizeAgentEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.some(key => !["runId", "category", "route"].includes(key))) return null;
  if (typeof input.runId !== "string" || !/^ORCH-[A-Z0-9]{4,24}$/.test(input.runId)) return null;
  if (typeof input.category !== "string" || !Object.hasOwn(ROUTES, input.category)) return null;
  if (!Array.isArray(input.route) || input.route.length > 4 || input.route.some(x => typeof x !== "string")) return null;
  const expected = ROUTES[input.category];
  if (input.route.length !== expected.length || input.route.some((name, i) => name !== expected[i])) return null;
  return Object.freeze({ runId: input.runId, category: input.category, route: [...expected] });
}
