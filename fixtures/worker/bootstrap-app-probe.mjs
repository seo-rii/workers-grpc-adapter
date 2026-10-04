// An application-owned protobuf copy is deliberately outside every profile path.
// Its dynamic codec remains forbidden by workerd in both baseline and preset
// bundles; its reflection and explicit Writer/Reader behavior remain usable.
export function probeApplicationProtobuf(P) {
  const schema = { nested: { ApplicationOwned: { fields: {
    label: { type: 'string', id: 1 }, count: { type: 'int64', id: 2 },
  } } } };
  let root, rootFromJSON;
  try { root = P.Root.fromJSON(schema); rootFromJSON = 'passed'; }
  catch (error) { rootFromJSON = error.name; }
  // protobuf7.6 eagerly resolves fromJSON and therefore hits codegen before
  // any codec call. Preserve and report that baseline failure. The separate
  // ordinary addJSON reflection API lets us inspect the independent package
  // without patching its constructor or enabling dynamic code generation.
  if (!root) root = new P.Root().addJSON(schema.nested);
  const type = root.lookupType('ApplicationOwned');
  const bytes = new P.Writer().uint32(10).string('application-owned').uint32(16).int64('42').finish();
  const reader = P.Reader.create(bytes);
  const wire = [reader.uint32(), reader.string(), reader.uint32(), reader.int64().toString()];
  const largeIntegerRoundtrip = P.Reader.create(new P.Writer().int64('9007199254740993').finish()).int64().toString();
  let codegen;
  try { type.fromObject({ label: 'must-not-be-transformed' }); codegen = 'unexpected-success'; }
  catch (error) { codegen = error.name; }
  return { fields: type.fieldsArray.map(field => [field.name, field.type, field.id]), wire, codegen, rootFromJSON, largeIntegerRoundtrip,
    customSchemaAccepted: true, ownRootConstructor: root.constructor === P.Root };
}
