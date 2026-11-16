// `varlink-js/codegen` entry point (DESIGN.md §4.13, §5.7): `.varlink` text → one TypeScript module.
export {
  generate,
  generateFromService,
  GENERATOR_VERSION,
  type GeneratedFile,
  type GenerateFromServiceOptions,
  type GenerateOptions,
} from "./generate.ts";
