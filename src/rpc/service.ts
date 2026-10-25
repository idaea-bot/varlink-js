// The built-in interfaces of every server (DESIGN.md §5.4, §4.11): org.varlink.service and the InternalError
// interface (Q2), from the generated descriptors in src/interfaces/ (M6). All the built-in wiring is behind
// builtinInterfaces().
import { InterfaceNotFoundError } from "../core/errors/standard.ts";
import type { Interface, Member } from "../core/idl/ast.ts";
import { formatType } from "../core/idl/format.ts";
import { parseInterface } from "../core/idl/parser.ts";
import type { Handler, MethodEntry } from "../core/protocol/dispatch.ts";
import type { Codec } from "../core/types/codec.ts";
import type { CompiledInterface, IntsMode } from "../core/types/compile.ts";
import { compileDescriptor, type InterfaceDescriptor } from "../core/types/descriptors.ts";
import {
  InternalErrorInterface,
  OrgVarlinkService,
  type GetInfo_Output,
  type GetInterfaceDescription_Input,
  type GetInterfaceDescription_Output,
  type OrgVarlinkService_Handlers,
} from "../interfaces/index.ts";

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
 * A built-in descriptor compiled for the server's or connection's `ints` mode. The built-in IDLs contain no `int`
 * (test/unit/codegen/builtins.test.ts checks it), so their types are the same in both modes and overriding the
 * descriptor's `ints` (generated as "number") is sound.
 */
export function builtinDescriptor<D extends InterfaceDescriptor>(descriptor: D, ints: IntsMode): D {
  return { ...descriptor, ints };
}

/** A member's signature for {@link assertBuiltinCompatible}: its kind and types, without docs or markers. */
function signature(member: Member): string {
  if (member.kind === "method") return `method ${formatType(member.input)} -> ${formatType(member.output)}`;
  return `${member.kind} ${formatType(member.type)}`;
}

/** The built-in definitions' members by name, per built-in interface name (parsed on first use). */
let builtinMembers: ReadonlyMap<string, ReadonlyMap<string, Member>> | undefined;

/**
 * Checks an interface given under a built-in name (`org.varlink.service`, `INTERNAL_ERROR_INTERFACE`) against
 * the built-in definition: every member of `given` must exist there with the same kind and the same types
 * (compared with `formatType`; docs, member order and the experimental/more/upgrade markers are ignored). The
 * built-in definition validates such calls, so a member it lacks or types differently would make the generated
 * types lie. Other names are not checked.
 *
 * @throws {TypeError} for a member that is not in the built-in definition or differs from it.
 */
export function assertBuiltinCompatible(given: Interface): void {
  builtinMembers ??= new Map(
    [OrgVarlinkService, InternalErrorInterface].map((d) => [
      d.name,
      new Map(parseInterface(d.idl).members.map((m) => [m.name, m])),
    ]),
  );
  const own = builtinMembers.get(given.name);
  if (own === undefined) return;
  for (const m of given.members) {
    const b = own.get(m.name);
    if (b === undefined)
      throw new TypeError(`interface ${given.name}: ${m.kind} ${m.name} is not in the built-in definition`);
    if (signature(b) !== signature(m))
      throw new TypeError(`interface ${given.name}: ${m.kind} ${m.name} differs from the built-in definition`);
  }
}

/**
 * The built-in interfaces, compiled with the server's `ints` and codec from the generated descriptors:
 * `service` (`org.varlink.service`: GetInfo and GetInterfaceDescription) is listed first by GetInfo, `internal`
 * (`INTERNAL_ERROR_INTERFACE`, no methods) last.
 */
export function builtinInterfaces(
  host: BuiltinHost,
  options: { ints: IntsMode; codec: Codec },
): { service: RegisteredInterface; internal: RegisteredInterface } {
  const service = compileDescriptor(builtinDescriptor(OrgVarlinkService, options.ints), { codec: options.codec });
  const internal = compileDescriptor(builtinDescriptor(InternalErrorInterface, options.ints), {
    codec: options.codec,
  });
  const handlers = {
    GetInfo: (): GetInfo_Output => ({ ...host.info(), interfaces: host.interfaceNames() }),
    GetInterfaceDescription: (p: GetInterfaceDescription_Input): GetInterfaceDescription_Output => {
      const description = host.description(p.interface);
      if (description === undefined) throw new InterfaceNotFoundError({ interface: p.interface });
      return { description };
    },
  } satisfies OrgVarlinkService_Handlers;
  const impls = new Map<string, MethodImplementation>([
    ["GetInfo", { handler: handlers.GetInfo }],
    ["GetInterfaceDescription", { handler: handlers.GetInterfaceDescription }],
  ]);
  return {
    service: {
      name: service.name,
      idl: OrgVarlinkService.idl,
      compiled: service,
      entries: entriesOf(service, impls),
    },
    internal: {
      name: internal.name,
      idl: InternalErrorInterface.idl,
      compiled: internal,
      entries: entriesOf(internal, new Map()),
    },
  };
}
