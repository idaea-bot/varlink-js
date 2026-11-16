// Hand-written interfaces for the codegen tests (DESIGN.md §4.13).

/**
 * Member and type names that shadow globals the generated code must never reference by name, and a method whose
 * name equals the interface's const name (`VjsCollide` → `VjsCollide_Interface`), and optional fields named like
 * `Object.prototype` members (`Inherited`).
 */
export const COLLISIONS_IDL = `# Names that shadow globals.
interface vjs.collide

type Record (key: string)

type Array (items: []Record)

type Promise (then: ?string)

type Error (message: string)

type ErrorOptions (cause: ?any)

type Object (value: object)

type String (value: string)

type Symbol (s, t)

type JsonValue (v: any)

type VarlinkError (error: string)

type ConstructorParameters (p: ?Error)

# Optional fields named like members of the object prototype (absent ones must not read as the inherited ones).
type Inherited (
  constructor: ?int,
  toString: ?string,
  valueOf: ?bool,
  hasOwnProperty: ?int,
  isPrototypeOf: ?int,
  propertyIsEnumerable: ?int,
  toLocaleString: ?string
)

method Inherit(t: Inherited) -> (t: Inherited)

method VjsCollide(record: Record, array: Array) -> (promise: Promise, object: Object)

method Readonly(
  constructor: string,
  new: int,
  get: bool,
  set: float,
  readonly: ?bool,
  typeof: ?string,
  in: ?(a, b),
  enum: ?[]?String,
  default: [string]Symbol,
  prototype: ?ConstructorParameters
) -> ()

error TypeError (error: Error, options: ?ErrorOptions)

error Partial ()

error ReturnType (value: JsonValue, varlink: VarlinkError)
`;

/** Long names, long unions and deep nesting: exercises every line-breaking rule of the layout. */
export const LAYOUT_IDL = `# Layout stress test: long names, long unions, nesting.
# A doc line with */ inside.
interface org.example.layout.with-a-rather-long-interface-name

# [Experimental]
type VeryLongEnumerationTypeNameForLayoutTesting (alpha_value, beta_value, gamma_value, delta_value, epsilon_value, zeta_value, eta_value)

type ShortEnum (a, b)

# A struct with every type form.
type Nested (
  # Field doc with */ end marker.
  deeply_nested_optional_field_name: ?[]?[string]?(first_alternative, second_alternative, third_alternative, fourth),
  map_of_long_unions: [string](first_alternative_value, second_alternative_value, third_alternative_value),
  map_of_longer_unions: [string](first_alternative_value, second_alternative_value, third_alternative_value, fourth_alternative_value),
  array_of_long_union_values_here: [](first_alternative_value, second_alternative_value, third_alternative_value),
  array_of_longer_union_values: [](first_alternative_value, second_alternative_value, third_alternative_value, fourth_v),
  optional_long_union_field_name: ?(first_alternative_value, second_alternative_value, third_alternative_value),
  optional_array_of_structs: ?[](a: int, b: ?string),
  array_of_optional_structs: []?(a: int),
  optional_struct: ?(inner: ?(deeper: [string]())),
  optional_map_of_struct: ?[string](a: int),
  set: [string](),
  empty: (),
  obj: ?object,
  anything: ?any,
  recursive: ?Nested,
  nested_arrays: [][]?[]int,
  enumerated_field_with_doc: (
    # first doc
    one,
    # [Experimental]
    two
  )
)

# [Requires 'more' flag]
# [Supports 'upgrade' flag]
method AnExtremelyLongMethodNameForTestingTheLayoutOfTypeArguments(
  input_field_name_that_is_long: VeryLongEnumerationTypeNameForLayoutTesting
) -> (output: ?[]Nested)

# [Supports 'more' flag]
# [Experimental]
method Short() -> ()

# [Requires 'upgrade' flag]
method Upgrade() -> ()

error AnExtremelyLongErrorNameForTestingTheLayoutOfConstructorParametersAndCalls (reason: string)
`;

/**
 * The typed e2e interface: streams, oneway, nullable, map, any, object, int, errors with and without parameters,
 * a method that requires `more`.
 */
export const TEST_IDL = `# varlink-js typed e2e test interface.
interface org.example.typed

# A record with every field shape.
type Item (
  id: int,
  name: string,
  tags: [string]string,
  note: ?string,
  extra: ?any,
  raw: ?object,
  kind: (small, large)
)

# Returns the item with the given id.
method Get(id: int) -> (item: Item)

# Lists items; one reply per item.
# [Supports 'more' flag]
method List(limit: ?int) -> (item: Item)

# Streams events; only with \`more\`.
# [Requires 'more' flag]
method Watch() -> (event: string)

# Records a message; meant for oneway calls.
method Log(message: string) -> ()

# Echoes an \`any\` value and an \`object\`.
method Echo(value: any, obj: ?object) -> (value: any, obj: ?object)

# Declared but not implemented by the e2e server.
method Unimplemented() -> ()

# The item does not exist.
error NotFound (id: int)

# Try again later.
error Busy ()
`;
