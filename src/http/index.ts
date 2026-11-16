// `varlink-js/http` entry point (DESIGN.md §4.12): simple HTTP mode client (UAPI "Simple HTTP Mode").
export {
  createHttpClient,
  HttpClient,
  type FetchInitLike,
  type FetchLike,
  type HttpCallOptions,
  type HttpClientOptions,
  type HttpCollectOptions,
  type HttpRequestOptions,
  type HttpStreamOptions,
  type ReadableStreamLike,
  type ReadableStreamReaderLike,
  type ResponseLike,
} from "./client.ts";
export { HttpBridgeError } from "./errors.ts";
