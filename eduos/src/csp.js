// Content Security Policy for every page EduOS serves (used by src/server.js
// through helmet, and by the browser test that loads the district interface
// under exactly this policy).
export const cspDirectives = {
  defaultSrc: ["'self'"],
  // No inline script anywhere: the district interface's script lives in
  // public/legacy-app.js and its handlers are data-on-* attributes run by
  // public/legacy-events.js (named handlers, literal arguments, no eval).
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  // Still needed for the district interface's style="" attributes (about 270).
  // Inline style can't run script; tightening it is a separate change.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", "data:"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  // 'self' (not 'none') so the same-origin Vision Studio iframe can load;
  // other origins still cannot frame EduOS.
  frameAncestors: ["'self'"]
};
