// Public IDL API (DESIGN.md §4.8): parse, validate and format varlink interface definitions.
export type {
  ArrayType,
  EnumType,
  EnumValue,
  ErrorMember,
  Field,
  Interface,
  MapType,
  Member,
  MethodMember,
  NamedType,
  NullableType,
  Position,
  PrimitiveType,
  Span,
  StructType,
  Type,
  TypeMember,
} from "./ast.ts";
export { MAX_TYPE_DEPTH } from "./ast.ts";
export { IdlSyntaxError, type IdlErrorCode } from "./errors.ts";
export { formatInterface, formatType } from "./format.ts";
export { isFieldName, isInterfaceName, isMemberName } from "./names.ts";
export { parseInterface, type ParseOptions } from "./parser.ts";
export { validateInterface } from "./validate.ts";
