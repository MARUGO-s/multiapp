// Replace only browser launch, so real script startup and mkdir still execute.
const launchStub = `
export const chromium = {
  async launch() {
    throw new Error("QR_LOGO_STARTUP_BROWSER_LAUNCH_REACHED");
  },
};
`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "playwright")
    return {
      url: `data:text/javascript,${encodeURIComponent(launchStub)}`,
      shortCircuit: true,
    };
  return nextResolve(specifier, context);
}
