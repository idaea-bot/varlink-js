// @ts-check
// Local ESLint rule enforcing the DESIGN.md §4 layering: files in a layer may only import relative paths
// that resolve into the layer's allowed directories. Bare specifiers (node:*, built-ins, npm packages,
// the package's own name) are rejected, so the agnostic layers (core, rpc, idl, websocket, http, root entry) stay runtime-agnostic and dependency-free.
import { dirname, relative, resolve, sep } from "node:path";

/** @param {string} p */
const posix = (p) => p.split(sep).join("/");

/** @type {import("eslint").Rule.RuleModule} */
export const layerBoundaries = {
  meta: {
    type: "problem",
    docs: { description: "Restrict imports of runtime-agnostic layers (DESIGN.md §4)" },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          layers: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        },
        required: ["root", "layers"],
        additionalProperties: false,
      },
    ],
    messages: {
      bare: "{{layer}} must stay runtime-agnostic and dependency-free (DESIGN.md §4): no import of '{{spec}}'.",
      outside: "{{layer}} may only import from {{allowed}} (DESIGN.md §4); '{{spec}}' resolves to {{target}}.",
      dynamic: "{{layer}}: import() with a computed specifier cannot be checked (DESIGN.md §4).",
    },
  },
  create(context) {
    const { root, layers } = /** @type {{ root: string, layers: Record<string, string[]> }} */ (context.options[0]);
    const file = posix(relative(root, context.filename));
    const layer = Object.keys(layers).find((l) => file === l || file.startsWith(l + "/"));
    if (layer === undefined) return {};
    const allowed = layers[layer] ?? [];

    /** @param {import("estree").Node} node @param {unknown} spec */
    function check(node, spec) {
      if (typeof spec !== "string") {
        context.report({ node, messageId: "dynamic", data: { layer } });
        return;
      }
      const relativeSpec = spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
      if (!relativeSpec) {
        context.report({ node, messageId: "bare", data: { layer, spec } });
        return;
      }
      const target = posix(relative(root, resolve(dirname(context.filename), spec)));
      if (!allowed.some((dir) => target === dir || target.startsWith(dir + "/"))) {
        context.report({ node, messageId: "outside", data: { layer, spec, target, allowed: allowed.join(", ") } });
      }
    }
    /** @param {any} n */
    const literal = (n) => (n?.type === "Literal" ? n.value : undefined);
    /** @param {any} n */
    const fromTemplate = (n) =>
      n?.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked : undefined;

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => check(node, literal(node.source) ?? fromTemplate(node.source)),
      /** @param {any} node `import("x").T` in type positions */
      TSImportType: (node) => check(node, literal(node.argument?.literal) ?? literal(node.argument)),
      /** @param {any} node `import x = require("x")` */
      TSExternalModuleReference: (node) => check(node, literal(node.expression)),
      /** @param {any} node `declare module "x" {}` (also banned by no-restricted-syntax) */
      TSModuleDeclaration: (node) => node.id?.type === "Literal" && check(node, node.id.value),
    };
  },
};
