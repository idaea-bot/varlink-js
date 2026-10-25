// Types (DESIGN.md §4.3, §4.9): JSON codec, compiled validators and the descriptor types codegen emits.
export { createJsonCodec, jsonCodec, type Codec, type JsonCodecOptions } from "./codec.ts";
export {
  compileInterface,
  compileInterfaceText,
  MAX_ENCODE_ARRAY_LENGTH,
  MAX_VALUE_DEPTH,
  type CompiledInterface,
  type CompiledMethod,
  type CompileOptions,
  type DecodeOptions,
  type IntsMode,
  type Validator,
} from "./compile.ts";
export {
  assertIntsMode,
  compileDescriptor,
  type InterfaceDescriptor,
  type JsonValue,
  type MethodDescriptor,
  type MethodInput,
  type MethodOutput,
} from "./descriptors.ts";
