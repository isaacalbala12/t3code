/**
 * DeepSeekAdapter — shape type for the DeepSeek Harness (`dsh acp`) adapter.
 *
 * Like the other ACP drivers, one adapter is bundled per instance as a closure
 * by {@link ../Drivers/DeepSeekDriver}; only the shape interface is exported.
 *
 * @module DeepSeekAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DeepSeekAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
