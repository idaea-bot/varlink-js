// createPool(address): the runtime-agnostic Pool over connect() (DESIGN.md §5.2, §4.11).
import type { AddressSpec } from "../core/address/parse.ts";
import type { ConnectionOptions } from "../rpc/connection.ts";
import { createPool as createFactoryPool, type Pool, type PoolOptions } from "../rpc/pool.ts";
import { connect } from "./connect.ts";

/**
 * A {@link Pool} of connections to `address` (DESIGN.md §5.2): `max`/`idleTimeout` configure the pool, every other
 * option is passed to each {@link connect} (whose connect phase is aborted when the waiting operation gives up or the
 * pool closes).
 */
export function createPool(address: string | AddressSpec, options?: PoolOptions & ConnectionOptions): Pool {
  const { max, idleTimeout, ...connectionOptions } = options ?? {};
  const poolOptions: PoolOptions = {
    ...(max === undefined ? {} : { max }),
    ...(idleTimeout === undefined ? {} : { idleTimeout }),
  };
  return createFactoryPool((signal) => connect(address, { ...connectionOptions, signal }), poolOptions);
}
