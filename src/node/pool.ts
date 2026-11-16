// createPool(address): the runtime-agnostic Pool over connect() (DESIGN.md §5.2, §4.11).
import type { AddressSpec } from "../core/address/parse.ts";
import type { ConnectionOptions } from "../rpc/connection.ts";
import { createPool as createFactoryPool, type Pool, type PoolOptions } from "../rpc/pool.ts";
import { connect } from "./connect.ts";

/**
 * A {@link Pool} of connections to `address` (DESIGN.md §5.2): `max`/`idleTimeout` configure the pool, `timeout`
 * both the pool (lease wait) and the connections, every other option is passed to each {@link connect} (whose
 * connect phase is aborted when the waiting operation gives up or the pool closes).
 */
export function createPool(address: string | AddressSpec, options?: PoolOptions & ConnectionOptions): Pool {
  const { max, idleTimeout, ...connectionOptions } = options ?? {};
  const timeout = connectionOptions.timeout;
  const poolOptions: PoolOptions = {
    ...(max === undefined ? {} : { max }),
    ...(idleTimeout === undefined ? {} : { idleTimeout }),
    ...(timeout === undefined ? {} : { timeout }),
  };
  return createFactoryPool((signal) => connect(address, { ...connectionOptions, signal }), poolOptions);
}
