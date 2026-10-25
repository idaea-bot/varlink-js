// The built-in interfaces of every server (DESIGN.md §5.4, §4.11): org.varlink.service and the InternalError
// interface (Q2). All the built-in wiring is behind builtinInterfaces(), so M6 can swap in generated code.
import {
  INTERNAL_ERROR_INTERFACE_IDL,
  InterfaceNotFoundError,
  ORG_VARLINK_SERVICE_IDL,
} from "../core/errors/standard.ts";
import type { Handler, MethodEntry } from "../core/protocol/dispatch.ts";
import type { Codec } from "../core/types/codec.ts";
import { compileInterfaceText, type CompiledInterface, type IntsMode } from "../core/types/compile.ts";

/** A registered interface as the server's dispatch table sees it. */
export interface RegisteredInterface {
  readonly name: string;
  /** Verbatim IDL text (GetInterfaceDescription). */
  readonly idl: string;
  readonly compiled: CompiledInterface;
  readonly entries: ReadonlyMap<string, MethodEntry>;
}

/** A handler plus the flags it raises (never lowers) over the IDL's. */
export interface MethodImplementation {
  readonly handler: Handler<never>;
  readonly requiresMore?: boolean;
  readonly requiresUpgrade?: boolean;
}

/** Dispatch entries for every method of `compiled`; methods without an implementation are MethodNotImplemented. */
export function entriesOf(
  compiled: CompiledInterface,
  impls: ReadonlyMap<string, MethodImplementation>,
): Map<string, MethodEntry> {
  const entries = new Map<string, MethodEntry>();
  for (const m of compiled.methods.values()) {
    const impl = impls.get(m.name);
    const more = impl?.requiresMore === true ? "requires" : m.member.more;
    const upgrade = impl?.requiresUpgrade === true ? "requires" : m.member.upgrade;
    entries.set(m.name, {
      input: m.input,
      output: m.output,
      handler: impl?.handler,
      ...(more === undefined ? {} : { more }),
      ...(upgrade === undefined ? {} : { upgrade }),
    });
  }
  return entries;
}

/** What the built-in methods need from their server. */
export interface BuiltinHost {
  /** GetInfo's `vendor`, `product`, `version`, `url`. */
  info(): { vendor: string; product: string; version: string; url: string };
  /** Every interface name in GetInfo order. */
  interfaceNames(): string[];
  /** The verbatim IDL of a registered interface (built-ins included), from a Map; undefined if unknown. */
  description(name: string): string | undefined;
}

/**
 * The built-in interfaces, compiled with the server's `ints` and codec: `service` (`org.varlink.service`, from
 * `ORG_VARLINK_SERVICE_IDL`: GetInfo and GetInterfaceDescription) is listed first by GetInfo, `internal`
 * (`INTERNAL_ERROR_INTERFACE`, no methods) last.
 */
export function builtinInterfaces(
  host: BuiltinHost,
  options: { ints: IntsMode; codec: Codec },
): { service: RegisteredInterface; internal: RegisteredInterface } {
  const service = compileInterfaceText(ORG_VARLINK_SERVICE_IDL, options);
  const internal = compileInterfaceText(INTERNAL_ERROR_INTERFACE_IDL, options);
  const getInfo: Handler<never> = () => ({ ...host.info(), interfaces: host.interfaceNames() });
  const getInterfaceDescription: Handler<{ interface: string }> = (p) => {
    const description = host.description(p.interface);
    if (description === undefined) throw new InterfaceNotFoundError({ interface: p.interface });
    return { description };
  };
  const impls = new Map<string, MethodImplementation>([
    ["GetInfo", { handler: getInfo }],
    ["GetInterfaceDescription", { handler: getInterfaceDescription }],
  ]);
  return {
    service: {
      name: service.name,
      idl: ORG_VARLINK_SERVICE_IDL,
      compiled: service,
      entries: entriesOf(service, impls),
    },
    internal: {
      name: internal.name,
      idl: INTERNAL_ERROR_INTERFACE_IDL,
      compiled: internal,
      entries: entriesOf(internal, new Map()),
    },
  };
}
