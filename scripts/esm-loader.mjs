// ESM loader: intercepts axios and google-spreadsheet with file-based mocks
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "axios") {
    return { shortCircuit: true, url: new URL("/tmp/axios-mock.mjs", "file://").href };
  }
  if (specifier === "google-spreadsheet") {
    return { shortCircuit: true, url: new URL("/tmp/sheets-mock.mjs", "file://").href };
  }
  if (specifier === "google-auth-library") {
    return { shortCircuit: true, url: "data:text/javascript,export class JWT{constructor(){}async authorize(){}}" };
  }
  return nextResolve(specifier, context);
}
