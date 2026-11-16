// Name grammars (UAPI.20 "Names"), written without ambiguous repetitions so matching stays linear.

/** `[A-Za-z]([-]*[A-Za-z0-9])*(\.[A-Za-z0-9]([-]*[A-Za-z0-9])*)+` */
export const INTERFACE_NAME_RE: RegExp =
  /^[A-Za-z][A-Za-z0-9]*(?:-+[A-Za-z0-9]+)*(?:\.[A-Za-z0-9]+(?:-+[A-Za-z0-9]+)*)+$/;
/** `[A-Z][A-Za-z0-9]*`: type, method and error names. */
export const MEMBER_NAME_RE: RegExp = /^[A-Z][A-Za-z0-9]*$/;
/** `[A-Za-z](_?[A-Za-z0-9])*`: struct fields, method parameters and enum values. */
export const FIELD_NAME_RE: RegExp = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;

/** Whether `s` is a valid interface name (reverse-domain, at least two components). */
export function isInterfaceName(s: string): boolean {
  return INTERFACE_NAME_RE.test(s);
}

/** Whether `s` is a valid type, method or error name. */
export function isMemberName(s: string): boolean {
  return MEMBER_NAME_RE.test(s);
}

/** Whether `s` is a valid field, parameter or enum value name. Keywords are allowed. */
export function isFieldName(s: string): boolean {
  return FIELD_NAME_RE.test(s);
}
