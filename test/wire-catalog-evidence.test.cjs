'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { catalogCases, validateWireCatalogReport } = require('../scripts/wire-catalog-evidence.cjs');

// Frozen, compact receipts captured from the controlled 2026-10-03 development
// run. They are validator fixtures, never newly executed compatibility evidence.
// Repeated runtime/mode and reserved-flag rows are reconstructed below; the
// validator uses its independently reviewed manifest, not this receipt table.
// Public columns: id, variant, kind, catalogMatch, code, details, decoded,
// initial metadata, final metadata, source counters, parser peaks, byte peak,
// header/trailer/request budgets. This keeps all SHA256 byte oracles readable.
const publicReceipts = [
  [1,"normal-unary","unary",true,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[3,2,33,0],[12,12],48,[null,null,null]],
  [2,"present-zero-byte-message","unary",true,0,"",[{"length":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}],[{}],{},[3,2,26,0],[5,5],48,[null,null,null]],
  [3,"trailer-only-empty-server-stream","stream",true,0,"",[],[{}],{},[2,1,21,0],[0,0],48,[null,null,null]],
  [4,"header-split-1","unary",true,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[3,2,33,0],[12,32],59,[null,null,null]],
  [4,"header-split-2","unary",true,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[3,2,33,0],[12,31],58,[null,null,null]],
  [4,"header-split-3","unary",true,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[3,2,33,0],[12,30],57,[null,null,null]],
  [4,"header-split-4","unary",true,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[3,2,33,0],[12,29],56,[null,null,null]],
  [5,"every-response-byte-separate","unary",true,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[34,33,33,0],[12,1],28,[null,null,null]],
  [6,"128-ordered-frames-and-trailer-in-one-chunk","stream",true,0,"",[{"length":3,"sha256":"466c0d1583414ad14a941ca28bb6147838ab3d3c8223e7c1fb61dd09e3f1d26d"},{"length":3,"sha256":"23c2419f55e003644e6f36c2f5b52b3c47ed95de403400b8b1c9aa08ec2492f4"},{"length":3,"sha256":"9689eef67a7cbf26a27093635b33c32228a4f7af6db541b8a790fcd08cb0bbfa"},{"length":3,"sha256":"e30eaaa5cba5de1616eba3e5f0da7f49952eb3dc6c0f899fdc1c74358898c54c"},{"length":3,"sha256":"c6f1b6f881acce012efba758d47a42166aa8b2d9272f204e58a90866c269cb2d"},{"length":3,"sha256":"a3afbe1c7ca145a01e28836226704869cafed900942d84ab9a1c8a5da2f2834f"},{"length":3,"sha256":"8718dcee7886023b98d419cc61f5e8e928fa703b1a0df496cd05ceb577bf2412"},{"length":3,"sha256":"3d02c42480ea7adf9a36a2126fec29ab9b96bd90243f0df3a06abe260367cb58"},{"length":3,"sha256":"871f4f85743e3db5ad3e2fdab9c3de8262b55cd9b6e04b388d1a0b1562181464"},{"length":3,"sha256":"ee56aa1bc34a424d4f48ef76a9ce2bc06360e939873749c427407c4293e4529f"},{"length":3,"sha256":"dad9903f7ae67857c699c6e92a0b3756faad31c087a02701dd6f5b147891d1fc"},{"length":3,"sha256":"7632f3348f4ad698bcbfb3ae3f3932377f86324c46cdf4f0c08af1964835b170"},{"length":3,"sha256":"ccb2a99fafff7dbb66c8593e447cd159cf5f1e8b767737e1dd679647e6eaac82"},{"length":3,"sha256":"b623b66093d8828b9736145968d078d63ae360742ff25f1e3b14709f78706777"},{"length":3,"sha256":"d550f1dca67c9a04c0d456e02d42c1c7d66f017f6fc2a677994ad1c77352ba68"},{"length":3,"sha256":"e882950f9aa87cfab1210d88ae64c119f99c3d56de5614193579160bb231e130"},{"length":3,"sha256":"7fb513dbf89979d432fcd98c1914647e36d58b8a97f7dca787b5f2ef843a2ad6"},{"length":3,"sha256":"7d1255e7e6bb0b50e5e884d1156ce6afa4f8c2c2517de3200e62c0a8cc86bb0e"},{"length":3,"sha256":"75199c9741452b5f5b77480f5ebedd0f7f1752d86d8593bdfb3a260ee66cf320"},{"length":3,"sha256":"b071821d7ef0abdd02046d3c8ba18344fae766da1fa5bce0f52ec52f81fbf916"},{"length":3,"sha256":"0747d3aee7899d39b7ca29f839c78c3ce7fb2d95735ff1819705f0bd00ee8615"},{"length":3,"sha256":"fd70d61737cf37a632f13e4164be4d15c0470b9103e2560b06598faf1eb1f81e"},{"length":3,"sha256":"eb52f0a8246584cd3fd5d9d8d479b456f8706b81efdafe901479ef4e57d92eaf"},{"length":3,"sha256":"1be9300844a020726f6403664a7e9ff51e0e774bb5fd0d22590a54d884120de3"},{"length":3,"sha256":"ca07cc50d30364bc90794b045761a0dec9b22619ae9f51bef8dc6e0c9ea77064"},{"length":3,"sha256":"6de4db7a540d15411266a44206578701cf0ac8641fe0625ca81d74d27540b8b5"},{"length":3,"sha256":"c8aa854b12426ddd65ef028ccae551336ab6321333f3b243cdafe76441d7ee01"},{"length":3,"sha256":"8a5cd28f273dd1d7c57850e3b182b23406f5809739f739b45f280b1578faddb7"},{"length":3,"sha256":"463722ac6444b1f9e001b3243e0369568d0c1b91d62f9726db229a34ed1e065d"},{"length":3,"sha256":"80e7843ae8cfa6b76e580535478fc1aa5bf60203e33813e6af219f4cba101beb"},{"length":3,"sha256":"1734b1616e736f8028cdab723f440b913c9a58801daed1da81e0087eed708db6"},{"length":3,"sha256":"fc65f405df560f4d94d4cc713fed71ef5fdce29eb6c4774a7e1bc5bc932bbda7"},{"length":3,"sha256":"98f7a793cea3ec0acc10718ca4355e84d2c984ce5afcaa583d37d4862f069c6d"},{"length":3,"sha256":"0178feed578d346284614d71ac8e9ba1f0017523803131bd7578cd9e025e6261"},{"length":3,"sha256":"2a2e10d35adb5bfeb942251353c1356800e6e851a507b0ad6b681d1cedf83996"},{"length":3,"sha256":"f24fad492ac5c69d54c0c8a8d43c5b7f877fe0ac2f69208240358fc4e19575c1"},{"length":3,"sha256":"7fdd13eb1cce5b0743ccc34b31afe9f06cd01ab97622ed5cbd42cc1eb0eb720c"},{"length":3,"sha256":"03f85d429239e1bdb1f16ad12b64edb34682cbcb6a0acef9243f470cd5a8d2b8"},{"length":3,"sha256":"54e4f06ff20e68f9d58faa172af66e99118cd788c65a6b83b8b7ea8832eaaec9"},{"length":3,"sha256":"d63b480b90480c38f31978be27462abb2623028c97698716c4a255cdb94c0b6a"},{"length":3,"sha256":"bbe5a289936be7337d5695755455da62fdf70e5c5eaff19770ed9db17baf2ba3"},{"length":3,"sha256":"0055918dc9ee9df95431b185f8d72e8bea9801c9e629ca73b4a6e582019e22e2"},{"length":3,"sha256":"e1e0ffeaa8a38b7e86c246f9303b2352e2740cf8e711a0f49c5ef69b22d2e410"},{"length":3,"sha256":"718c91dd2035772b13d45eada93e56dea9751dbbd36a52322598bddc6e09c380"},{"length":3,"sha256":"22cd2b68a7c2f50c25faaf193a77ad9b0381f44770725deaad2f30cf25d2b032"},{"length":3,"sha256":"5f54b42411b5d37b8e66c4be204f1ece64fd363270a2da70a4b2c22296d85240"},{"length":3,"sha256":"b2d26bc1fb456451e9c673060e645118551519130cd558c8dadcbd3a6067a6bb"},{"length":3,"sha256":"8f476211f8616e444b72442904c3e6fca11f74664f9c33b5b910b091f6964983"},{"length":3,"sha256":"ae214fc6bdc15cb417444824940fee5b3ec8711ce39276c7679a6ea9da1a88f5"},{"length":3,"sha256":"59d311a00f1405aad5f5c7189b1416feab4385635a050d854a1bf23ecb0890cb"},{"length":3,"sha256":"fb5bad35f961d84da628b1a8d0d10c179d995fd6c4f03d12c271aeaeaef880ee"},{"length":3,"sha256":"9adac3dfda92c18e5305271d96c533abbe78c265718418923b71704bedfb83fe"},{"length":3,"sha256":"5d0c0ededbc5cb7049737b29bd85604f16a7bcbc2b948b6357eb871df2c2a89b"},{"length":3,"sha256":"2f4f338940dd7f18adc5fb13cf246b40448e7d2f0591dfe192751e4dc50855c1"},{"length":3,"sha256":"78356ee1ead3c5dba601a868e49d05f87571e8c0a49a9a016953b2269781a0e6"},{"length":3,"sha256":"0bca44afd2fc1fef6c2976453509027bf9e9a2999f8ad419ac0a346a5617f51a"},{"length":3,"sha256":"943b10408844fb2f483b933f90a947c7bfca78f7156be99433311d1851c1cffa"},{"length":3,"sha256":"bcb14a100f6f692721f31ace5c337416d2f0ec441d58e2e07df33f23c8a38f5e"},{"length":3,"sha256":"ee77d13f705cbddfaab4238df28042f809c4978319ecae8b64fbaea258365e1e"},{"length":3,"sha256":"9c7cbb8e34d10ee1044eed5431233303e34512a66179a6b97e96e899cf531c6a"},{"length":3,"sha256":"fa7e6c1241d30e34120ba5db772dab1b0c39a96edbc2868500d095165c6d1434"},{"length":3,"sha256":"c36454b1ee4ecdffe2a34faa02abe661a8ee2944f1e92630e266b7ff597abfad"},{"length":3,"sha256":"d9a3c8ac24bd205b0f8395db1cad741a0880e578e91868ed5f91914a92474281"},{"length":3,"sha256":"ed454675ad814b446676184b4eeeaca3652d37e465df09476aa872c8e88a5dc4"},{"length":3,"sha256":"82a294602fca275f42bb71b7edcf305643ff4e0c2f26127f823a05592cddc1ef"},{"length":3,"sha256":"ba5159a36bdc6333ab8bbe981309931cafefa5ee2b4d4d8bb63c405249e38056"},{"length":3,"sha256":"9b71ff3ff1d6ce3210768a3219a338c30f3369ba3a206329566316861e7f53b7"},{"length":3,"sha256":"dad13d01b1c432dac93b661ed3620ad305e25e5deec7f376bd49530422c8f1c8"},{"length":3,"sha256":"b5fd39c3b362e57bf8becc26264e3d936904f995051a871d48715f79226d696e"},{"length":3,"sha256":"59cf2ba15a9822fa3ca3e2448420e540323361f61503da91f0ecb8d54b0f05e4"},{"length":3,"sha256":"34ccd800a83bfd5b7ff91e36ef3a15a76618b1ac802798b55157c0c14e2647a4"},{"length":3,"sha256":"4cfa723d5abd06ab38172a8d62897777865c1649975f7ace56f19520756d28a4"},{"length":3,"sha256":"e3399f0a1638b5ce80c06bfd3c7452310c7ae357455dfb28627e661ea5a06d99"},{"length":3,"sha256":"f70ed4bef4ed29828eee68a61fd5f742a2d82b7c8d60e3ef874ee889e098fcd3"},{"length":3,"sha256":"0c5586e502e2896a0f9c33f3b0853b9ad629bd8e92341ea1670afc29c2479fde"},{"length":3,"sha256":"d6b42a258e618e7aef4c48f25dc02c166d9fd8e9e3a7ef4ed3173cfe8973c28f"},{"length":3,"sha256":"168a0a62b39fdf1bd699cd07810a8dc026d5ade9948e7c2fa36a4d03f3996fdc"},{"length":3,"sha256":"70a6fb07d0660c7e8ddba59f4771e243b9ca94dd59628f1e457544a93dbbf9e9"},{"length":3,"sha256":"76f943c138c905adb217c0b8eda531f4adf332ffed880ab1c7e5216c55504401"},{"length":3,"sha256":"25d290a60d35768f440abdfd57b3cf2528fe07e69cb24523fea92d8d066c789e"},{"length":3,"sha256":"ea701c441baa98aa5a7f033c29a8ce3d803622db79a94adb578cc1e6d9879327"},{"length":3,"sha256":"6b9b6b2d0f520100a9b10c397a35dff8999772247e805c30557b25578e3ce611"},{"length":3,"sha256":"725fc095866ffb0c94371221a2c68f6d58d2be8692a8c3497d38b04f36593781"},{"length":3,"sha256":"e730dab07c07c3d5cf09c5d23603d62a27312344586b56dfab8d0c98ddc56ffe"},{"length":3,"sha256":"93533a10ecbad46a3cbfa51aea8e32f8f20c14e8cc4c4a0d8dc237274593778f"},{"length":3,"sha256":"2c947a57e527f5cf9499bb42dab69c3ddf7530c41661e59cf567bad31a761562"},{"length":3,"sha256":"b65a39287dec0e0c60537c4de1eb0f763878aa5f32f5b47c10750d4292fda2fc"},{"length":3,"sha256":"9e8c27d39c33300ea37d6b4df78bea7af5aa3cdf51412489b35a1784f796a3b5"},{"length":3,"sha256":"3cc7f9716393f5e5035d6072bd340ad4ca11bcf5544ed9bd5146b7a0ec34861f"},{"length":3,"sha256":"d5dfd5318cadfe34a4d51b3ff0032bb23bfb5191df3a37b4586f82bad46eacf4"},{"length":3,"sha256":"3d723676a68e020803ea0104421f12957dded979a2a32e639d980cea86afa0e4"},{"length":3,"sha256":"bda13ab02fafb73cdce6d249681eafcd53f49c95df254e678643b7eb29ce8cc4"},{"length":3,"sha256":"e80e3b60730ed0d0a364e75e8efa8759d8a5635607a256063b8880c89e008a5c"},{"length":3,"sha256":"ba8709b08c88fcf9d12ab2c80486433f271a77ae9f80d898ec2a0f9887b5926a"},{"length":3,"sha256":"246f28315dc4fe2d4eb88dbdf5312fe031c415a59f9e3be8c599bbdcd3ae265a"},{"length":3,"sha256":"70e8b7da6e8aff1ec27b40b2b9713698cd8043fa4a23e1f0286ad92eedb8ca6a"},{"length":3,"sha256":"0c98109e31f16039bd9a070e1d59f8814fbfe4b5a59f27ef49879373a1af5d4d"},{"length":3,"sha256":"ead20a06064a9cca5aab742261775235ce2399687959a438a3365fe8a6cfd88d"},{"length":3,"sha256":"4934e74a045c72fab9f65bde9aea8734632c8fd7ee0a397934183adaa4d87925"},{"length":3,"sha256":"5452dba596cca0b06e2ffe48273ac4cba4f6c2b4665ba9a24eaa02740dab0e62"},{"length":3,"sha256":"93aa8d20b1bd7f2098dbf312f907a54de3f4dd14ed6dbadfa8f75c20e8e9ede1"},{"length":3,"sha256":"bc04cf814527c7dc8170392897e992cc071a7bead1e97e01fa51d7b56e2321a6"},{"length":3,"sha256":"567b5a809d84ed2a82b5e7a631319156f0cd5f828310614734cfa17c19d25e1a"},{"length":3,"sha256":"d7635112ace24d54e613cf73d07cd68610aba0b4b5a1864dfe371d879a482208"},{"length":3,"sha256":"f460e733051dc8b92dbd61c84894c7b398e3f081efec6ba4909805b44db9aa68"},{"length":3,"sha256":"00be4560cc8c93d98bb646d54bf8ac85f5124a32bb32a39d6e80e207c7c6cca3"},{"length":3,"sha256":"2dac04ee32b141652b99abc46684cf43dcbc2a6c110cda1797f599fc0de544b4"},{"length":3,"sha256":"57cd4c50e39bd188db52c6e810d6813083a27f3378c7bb798edb13fb6be3d6d9"},{"length":3,"sha256":"4fd070c6c521402b1857fba386a2c14dce21df06ea6cc93e5cd1d4b61c9779e2"},{"length":3,"sha256":"bd0717d2a3c4dfdf52a51189324cee238fe35f48c9d105e518e123ce4f92f620"},{"length":3,"sha256":"f373777d87b3807e043b5f53f959f293fffee07725e8b18e5556c8d9a94f0daf"},{"length":3,"sha256":"e5a2532b036c87f8442c8ef8d2eb7a1ad7027c9bc1f6ae8ec835e32e2349f3dc"},{"length":3,"sha256":"e9961a220ce5462009df9eb3ae5fc4954cadeddcef36e7ffecefdcb8f0c89d16"},{"length":3,"sha256":"7a97dc1d1eadf1af6e9b9054b3eb9a418944ceb9102b9f814544a35b34cf7178"},{"length":3,"sha256":"cfe3105b9ef7278d1387d117ae0f86d28ea614e4b6668dc93a0db886f3785da6"},{"length":3,"sha256":"cb0d26db4ed72159fe89f6cb589bf910105ca1c849c75cbc637ab8706644c057"},{"length":3,"sha256":"aa6588ab997d2d8cf5b63edc9459bbe0f20ffab1b54f86eda9844cc99adc725f"},{"length":3,"sha256":"d46f5026861ae676c4b7a1881254330f79269cb1b39b43778353622a704208a5"},{"length":3,"sha256":"054d557d33fb7af1cdac6bcc6039fec4638b772c0c8250b9da18f22a588db0b0"},{"length":3,"sha256":"7fc795e82f0e4e7b1a52823999d1bacbd09907ad1df98a21a725bc83363460b8"},{"length":3,"sha256":"62c8128fe3ebd674e41048f971eec47a5e9cbf1e03f129075d193d55932ed047"},{"length":3,"sha256":"73a6aca11a5a604f65122207271380ae45c43fff768dd6654fea6d9437ed617b"},{"length":3,"sha256":"10e311a76d1a760bdddd66e5d372ed328b65f68f63f9b87b615369323698e7f6"},{"length":3,"sha256":"3642045754d26d175b88bc0210973c08d0ccef67ca068c967596b838ee25b0f4"},{"length":3,"sha256":"9bd1b0da59f6fb4548b4c8ec3d76d4b0d1720b513dc7a78bc023d5287db0646c"},{"length":3,"sha256":"9244a0b1d9a6898a4fc1a8098ada73ada1421e5cd7fbf867cdeef02cabcf506e"},{"length":3,"sha256":"7a32096affea8d4eee0fa7b80c6d19f46b28cc4f85b7142f6d1610f6c4120694"},{"length":3,"sha256":"80754d36810035ea7835f28e10458a30f46a697b7c92350cd95ea3ad3a5fc4d7"}],[{}],{},[2,1,1045,0],[8,1045],1072,[null,null,null]],
  [7,"seeded-payload-and-trailer-1","unary",true,0,"",[{"length":1023,"sha256":"f67d98be17bf5e6b89b281b76ebf0ec59823eb104c3c4afe8958a139967af478"}],[{}],{"x-vector-seed":["1"],"x-vector-kind":["split"]},[73,72,1089,0],[1028,13],1065,[null,null,null]],
  [7,"seeded-payload-and-trailer-270544960","unary",true,0,"",[{"length":1023,"sha256":"50342f235771906005b9232b5b313483400976c601b1e728f2cdc6a60310c2cc"}],[{}],{"x-vector-seed":["270544960"],"x-vector-kind":["split"]},[70,69,1097,0],[1028,23],1065,[null,null,null]],
  [7,"seeded-payload-and-trailer-1592639710","unary",true,0,"",[{"length":1023,"sha256":"95a40d400a347981b6344b8b2d1f89b07d93fe26d2636fe03ab2b3e924491e80"}],[{}],{"x-vector-seed":["1592639710"],"x-vector-kind":["split"]},[69,68,1098,0],[1028,23],1065,[null,null,null]],
  [7,"seeded-payload-and-trailer-4294967295","unary",true,0,"",[{"length":1023,"sha256":"e560cf32d6d9a6df6fc96ff0f31e92093c0fee2386684b81067c2fbfaa487405"}],[{}],{"x-vector-seed":["4294967295"],"x-vector-kind":["split"]},[69,68,1098,0],[1028,23],1065,[null,null,null]],
  [8,"grpc-default-four-mib-below-limit","unary",true,0,"",[{"length":4194303,"sha256":"be771380b55ea4660783c387f6f3d43fdc3967d8ff10d063fcb8baed1c97effd"}],[{}],{},[67,66,4194329,0],[4194308,65535],4259850,[null,null,null]],
  [8,"grpc-default-four-mib-at-limit","unary",true,0,"",[{"length":4194304,"sha256":"5c6a10f42780949efc837cb3868a9031d6cfb6210dd107a65ef81a6faa9a807f"}],[{}],{},[67,66,4194330,0],[4194309,65536],4259851,[null,null,null]],
  [8,"grpc-default-four-mib-above-limit","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [8,"grpc-minus-one-default-transport-below-limit","unary",true,0,"",[{"length":33554431,"sha256":"a7c85b8c97b48015384b68aaa5dfdd75321d77aeb39dad0302cc18dbc42ec292"}],[{}],{},[515,514,33554457,0],[33554436,65535],33619978,[null,null,null]],
  [8,"grpc-minus-one-default-transport-at-limit","unary",true,0,"",[{"length":33554432,"sha256":"70c4eaba55c4010d636ac5b46ee640423ddcd44736057ad95429ea4fa4440e8a"}],[{}],{},[515,514,33554458,0],[33554437,65536],33619979,[null,null,null]],
  [8,"grpc-minus-one-default-transport-above-limit","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [8,"grpc-positive-65536-below-limit","unary",true,0,"",[{"length":65535,"sha256":"33d96107ca7e4d11a9da6d8d385b04986296bb00c8a85def2f883424c39cf493"}],[{}],{},[4,3,65561,0],[65540,65535],131081,[null,null,null]],
  [8,"grpc-positive-65536-at-limit","unary",true,0,"",[{"length":65536,"sha256":"391f637d45955f2ea51a2b5a25a02830ccef78af06b6e2cf9807439fcceedfd4"}],[{}],{},[4,3,65562,0],[65541,65536],131083,[null,null,null]],
  [8,"grpc-positive-65536-above-limit","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [8,"transport-minimum-over-positive-grpc-below-limit","unary",true,0,"",[{"length":1023,"sha256":"03172c7e0651681ce845af92bdc718b1af16f072be1f9ef5b6ea2faaae0f98be"}],[{}],{},[4,3,1049,0],[1028,1023],2057,[null,null,null]],
  [8,"transport-minimum-over-positive-grpc-at-limit","unary",true,0,"",[{"length":1024,"sha256":"801ef25dcaf548e555fe8508315384dcbf7eebd5369b0ec125dc3adc5cfdd6b6"}],[{}],{},[4,3,1050,0],[1029,1024],2059,[null,null,null]],
  [8,"transport-minimum-over-positive-grpc-above-limit","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [8,"grpc-minus-one-custom-transport-below-limit","unary",true,0,"",[{"length":4095,"sha256":"851e4510236b7a06eb805e007b5ed62f1ac09781303029412d9972818f6c6701"}],[{}],{},[4,3,4121,0],[4100,4095],8201,[null,null,null]],
  [8,"grpc-minus-one-custom-transport-at-limit","unary",true,0,"",[{"length":4096,"sha256":"4f7ddd35f27e5469457dbec653aa6fd5004a257b99f16689e5f3f8baf5aaa4d0"}],[{}],{},[4,3,4122,0],[4101,4096],8203,[null,null,null]],
  [8,"grpc-minus-one-custom-transport-above-limit","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [8,"grpc-positive-above-four-mib-below-limit","unary",true,0,"",[{"length":4259839,"sha256":"f4a6f0d76a2751a8d7966e5cbd9598a7c5ba87fea74474695bdda76eb7e0a92d"}],[{}],{},[68,67,4259865,0],[4259844,65535],4325386,[null,null,null]],
  [8,"grpc-positive-above-four-mib-at-limit","unary",true,0,"",[{"length":4259840,"sha256":"bef8f18fd5d287124a5cadb2262e9c3728854e5caf521149bc5419c99752ebbe"}],[{}],{},[68,67,4259866,0],[4259845,65536],4325387,[null,null,null]],
  [8,"grpc-positive-above-four-mib-above-limit","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [8,"transport-minimum-over-default-grpc-below-limit","unary",true,0,"",[{"length":2047,"sha256":"ceca57b729ba3b9481d90ccf635c2de0e8d4ecdf7945ed101c34120691da705e"}],[{}],{},[4,3,2073,0],[2052,2047],4105,[null,null,null]],
  [8,"transport-minimum-over-default-grpc-at-limit","unary",true,0,"",[{"length":2048,"sha256":"f512fdea9fe16a8a6f5a755499739b74ffb9691a4264a1b06b1fd42136dfdc73"}],[{}],{},[4,3,2074,0],[2053,2048],4107,[null,null,null]],
  [8,"transport-minimum-over-default-grpc-above-limit","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [8,"grpc-zero-limit-empty-accepted","unary",true,0,"",[{"length":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}],[{}],{},[3,2,26,0],[5,5],48,[null,null,null]],
  [8,"grpc-zero-limit-nonempty-rejected","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [8,"grpc-minus-one-crosses-four-mib-within-transport-cap","unary",true,0,"",[{"length":4194305,"sha256":"42060cdca3a866fb2d0382b7cf6a861019cc10754d85ba8ba733b63bd41a3d86"}],[{}],{},[68,67,4194331,0],[4194310,1],4259852,[null,null,null]],
  [9,"uint32-maximum-header-without-payload","unary",true,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [10,"truncated-header-1-bytes","unary",true,13,"WGA_TRUNCATED_FRAME",[],[{}],{},[2,1,1,0],[0,0],12,[null,null,null]],
  [10,"truncated-header-2-bytes","unary",true,13,"WGA_TRUNCATED_FRAME",[],[{}],{},[2,1,2,0],[0,0],13,[null,null,null]],
  [10,"truncated-header-3-bytes","unary",true,13,"WGA_TRUNCATED_FRAME",[],[{}],{},[2,1,3,0],[0,0],14,[null,null,null]],
  [10,"truncated-header-4-bytes","unary",true,13,"WGA_TRUNCATED_FRAME",[],[{}],{},[2,1,4,0],[0,0],15,[null,null,null]],
  [11,"payload-13-of-1024-bytes","unary",true,13,"WGA_TRUNCATED_FRAME",[],[{}],{},[3,2,18,0],[0,0],1048,[null,null,null]],
  [11,"payload-0-of-3-bytes","unary",true,13,"WGA_TRUNCATED_FRAME",[],[{}],{},[3,2,5,0],[0,0],19,[null,null,null]],
  [13,"compressed-trailer-unsupported","unary",false,12,"WGA_COMPRESSED_TRAILER",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [13,"compressed-with-identity","unary",false,13,"WGA_COMPRESSED_WITH_IDENTITY",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [13,"compressed-with-unsupported-snappy","unary",false,12,"WGA_COMPRESSION_ENCODING",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [13,"malformed-gzip","unary",false,13,"WGA_COMPRESSION_DATA",[],[{}],{},[1,1,9,1],[0,0],24,[null,null,null]],
  [13,"malformed-deflate","unary",false,13,"WGA_COMPRESSION_DATA",[],[{}],{},[1,1,9,1],[0,0],24,[null,null,null]],
  [13,"supported-gzip","unary",false,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[3,2,53,0],[32,32],84,[null,null,null]],
  [13,"supported-deflate","unary",false,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[3,2,41,0],[20,20],60,[null,null,null]],
  [13,"unknown-encoding-with-uncompressed-message","unary",false,0,"",[{"length":7,"sha256":"7bb6463b30f9e301fed333cdf8960ca9497b602ccd8eeb46ae42693fdea15a4d"}],[{}],{},[3,2,33,0],[12,12],48,[null,null,null]],
  [13,"gzip-decompressed-size-exceeds-grpc-cap","unary",false,8,"WGA_DECOMPRESSED_SIZE",[],[{}],{},[1,1,28,1],[0,0],62,[null,null,null]],
  [13,"gzip-wire-size-exceeds-transport-cap","unary",false,8,"WGA_FRAME_SIZE",[],[{}],{},[1,1,5,1],[0,0],16,[null,null,null]],
  [14,"duplicate-trailer-coalesced","unary",true,13,"WGA_FRAME_AFTER_TRAILER",[],[{}],{},[1,1,42,1],[0,0],69,[null,null,null]],
  [15,"data-after-trailer-coalesced","unary",true,13,"WGA_FRAME_AFTER_TRAILER",[],[{}],{},[1,1,33,1],[0,0],60,[null,null,null]],
  [14,"duplicate-trailer-separate-chunks","unary",true,13,"WGA_FRAME_AFTER_TRAILER",[],[{}],{},[2,2,42,1],[0,0],48,[null,null,null]],
  [15,"data-after-trailer-separate-chunks","unary",true,13,"WGA_FRAME_AFTER_TRAILER",[],[{}],{},[2,2,33,1],[0,0],48,[null,null,null]],
  [16,"data-without-status","stream",false,2,"WGA_MISSING_GRPC_STATUS",[{"length":4,"sha256":"333c03fe367760ee0bd77de250f261bf06d2c3d320f3066b0ce31e6e74d10052"}],[{}],{},[2,1,9,0],[9,9],24,[null,null,null]],
  [17,"http-200-permission-denied","stream",true,7,"permission denied",[{"length":4,"sha256":"333c03fe367760ee0bd77de250f261bf06d2c3d320f3066b0ce31e6e74d10052"}],[{}],{"x-trailing":["preserved"]},[3,2,88,0],[9,9],164,[null,null,null]],
  [18,"http-400","stream",true,13,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [18,"http-401","stream",true,16,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [18,"http-403","stream",true,7,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [18,"http-404","stream",true,12,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [18,"http-429","stream",true,14,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [18,"http-502","stream",true,14,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [18,"http-503","stream",true,14,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [18,"http-504","stream",true,14,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [18,"http-200","stream",true,2,"WGA_MISSING_GRPC_STATUS",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [19,"headers-only-non-ok-preserves-both-events","stream",true,16,"no auth",[],[{"trace-bin":[{"hex":"0001ff"}],"x-only":["preserved"]}],{"trace-bin":[{"hex":"0001ff"}],"x-only":["preserved"]},[1,0,0,0],[0,0],11,[null,null,null]],
  [20,"headers-alphabet","stream",true,13,"WGA_INVALID_STATUS",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [20,"headers-negative","stream",true,13,"WGA_INVALID_STATUS",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [20,"headers-out-of-range","stream",true,13,"WGA_INVALID_STATUS",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [20,"headers-duplicate","stream",true,13,"WGA_INVALID_STATUS",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [20,"headers-conflicting","stream",true,13,"WGA_INVALID_STATUS",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [20,"trailers-alphabet","stream",true,13,"WGA_INVALID_STATUS",[],[{}],{},[1,1,24,1],[0,0],54,[null,null,null]],
  [20,"trailers-negative","stream",true,13,"WGA_INVALID_STATUS",[],[{}],{},[1,1,22,1],[0,0],50,[null,null,null]],
  [20,"trailers-out-of-range","stream",true,13,"WGA_INVALID_STATUS",[],[{}],{},[1,1,22,1],[0,0],50,[null,null,null]],
  [20,"trailers-duplicate","stream",true,13,"WGA_DUPLICATE_STATUS",[],[{}],{},[1,1,37,1],[0,0],80,[null,null,null]],
  [20,"trailers-conflicting","stream",true,13,"WGA_DUPLICATE_STATUS",[],[{}],{},[1,1,37,1],[0,0],80,[null,null,null]],
  [20,"header-and-body-status-same","stream",true,13,"WGA_BODY_AFTER_HEADER_STATUS",[],[{}],{},[1,1,21,1],[0,0],48,[null,null,null]],
  [20,"header-and-body-status-conflicting","stream",true,13,"WGA_BODY_AFTER_HEADER_STATUS",[],[{}],{},[1,1,21,1],[0,0],48,[null,null,null]],
  [21,"headers-padded","stream",true,7,"",[],[{"trace-bin":[{"hex":"0102"}]}],{"trace-bin":[{"hex":"0102"}]},[1,0,0,0],[0,0],11,[null,null,null]],
  [21,"headers-unpadded","stream",true,7,"",[],[{"trace-bin":[{"hex":"0304"}]}],{"trace-bin":[{"hex":"0304"}]},[1,0,0,0],[0,0],11,[null,null,null]],
  [21,"headers-comma-combined","stream",true,7,"",[],[{"trace-bin":[{"hex":"0102"},{"hex":"0304"},{"hex":"0001ff"}]}],{"trace-bin":[{"hex":"0102"},{"hex":"0304"},{"hex":"0001ff"}]},[1,0,0,0],[0,0],11,[null,null,null]],
  [21,"trailers-padded","stream",true,7,"",[],[{}],{"trace-bin":[{"hex":"0102"}]},[2,1,54,0],[0,0],114,[null,null,null]],
  [21,"trailers-unpadded","stream",true,7,"",[],[{}],{"trace-bin":[{"hex":"0304"}]},[2,1,53,0],[0,0],112,[null,null,null]],
  [21,"trailers-comma-combined","stream",true,7,"",[],[{}],{"trace-bin":[{"hex":"0102"},{"hex":"0304"},{"hex":"0001ff"}]},[2,1,65,0],[0,0],136,[null,null,null]],
  [22,"request-repeated-text","unary",true,0,"",[{"length":4,"sha256":"333c03fe367760ee0bd77de250f261bf06d2c3d320f3066b0ce31e6e74d10052"}],[{}],{},[3,2,30,0],[9,9],48,[null,null,null]],
  [22,"request-repeated-text-and-binary","unary",true,0,"",[{"length":4,"sha256":"333c03fe367760ee0bd77de250f261bf06d2c3d320f3066b0ce31e6e74d10052"}],[{}],{},[3,2,30,0],[9,9],48,[null,null,null]],
  [23,"headers-alphabet","stream",true,13,"WGA_BINARY_METADATA",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [23,"headers-excess-padding","stream",true,13,"WGA_BINARY_METADATA",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [23,"headers-embedded-padding","stream",true,13,"WGA_BINARY_METADATA",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [23,"headers-noncanonical-trailing-bits","stream",true,13,"WGA_BINARY_METADATA",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [23,"trailers-alphabet","stream",true,13,"WGA_BINARY_METADATA",[],[{}],{},[1,1,54,1],[0,0],114,[null,null,null]],
  [23,"trailers-excess-padding","stream",true,13,"WGA_BINARY_METADATA",[],[{}],{},[1,1,56,1],[0,0],118,[null,null,null]],
  [23,"trailers-embedded-padding","stream",true,13,"WGA_BINARY_METADATA",[],[{}],{},[1,1,54,1],[0,0],114,[null,null,null]],
  [23,"trailers-noncanonical-trailing-bits","stream",true,13,"WGA_BINARY_METADATA",[],[{}],{},[1,1,54,1],[0,0],114,[null,null,null]],
  [23,"headers-extra-padding","stream",true,13,"WGA_BINARY_METADATA",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [23,"trailers-extra-padding","stream",true,13,"WGA_BINARY_METADATA",[],[{}],{},[1,1,55,1],[0,0],116,[null,null,null]],
  [24,"headers-korean","stream",true,7,"권한 거부",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [24,"headers-malformed-percent","stream",true,7,"bad%XX%2",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [24,"headers-incomplete-utf8","stream",true,7,"%ED%95",[],[{}],{},[1,0,0,0],[0,0],11,[null,null,null]],
  [24,"trailers-korean","stream",true,7,"권한 거부",[],[{}],{},[2,1,76,0],[0,0],158,[null,null,null]],
  [24,"trailers-malformed-percent","stream",true,7,"bad%XX%2",[],[{}],{},[2,1,45,0],[0,0],96,[null,null,null]],
  [24,"trailers-incomplete-utf8","stream",true,7,"%ED%95",[],[{}],{},[2,1,43,0],[0,0],92,[null,null,null]],
  [25,"headers-google-status-details","stream",true,7,"denied",[],[{"grpc-status-details-bin":[{"hex":"0807120664656e6965641a080a016512030001ff"}]}],{"grpc-status-details-bin":[{"hex":"0807120664656e6965641a080a016512030001ff"}]},[1,0,0,0],[0,0],11,[null,null,null]],
  [25,"trailers-google-status-details","stream",true,7,"denied",[],[{}],{"grpc-status-details-bin":[{"hex":"0807120664656e6965641a080a016512030001ff"}]},[2,1,98,0],[0,0],202,[null,null,null]],
  [26,"headers-budget-limit","stream",true,7,"권한 거부",[],[{"trace-bin":[{"hex":"0102"}],"x-pad":[{"length":65257,"sha256":"5653af960f09c955103d1b2c25bb8816d201014f6c0cbd7bad5fb1fab9ec07dc"}]}],{"trace-bin":[{"hex":"0102"}],"x-pad":[{"length":65257,"sha256":"5653af960f09c955103d1b2c25bb8816d201014f6c0cbd7bad5fb1fab9ec07dc"}]},[1,0,0,0],[0,0],11,[65536,null,null]],
  [26,"headers-budget-limit-plus-one","stream",true,8,"WGA_METADATA_SIZE",[],[],{},[0,0,0,1],[0,0],8,[65537,null,null]],
  [26,"trailers-budget-limit","stream",true,7,"권한 거부",[],[{}],{"trace-bin":[{"hex":"0102"}],"x-pad":[{"length":65327,"sha256":"b979887132ca47617b2945488c99672d891a688cb9417051e37df380ce420b8d"}]},[2,1,65429,0],[0,0],130864,[null,65536,null]],
  [26,"trailers-budget-limit-plus-one","stream",true,8,"WGA_METADATA_SIZE",[],[{}],{},[1,1,65430,1],[0,0],130866,[null,65537,null]],
  [26,"request-budget-limit","unary",true,0,"",[{"length":4,"sha256":"333c03fe367760ee0bd77de250f261bf06d2c3d320f3066b0ce31e6e74d10052"}],[{}],{},[3,2,30,0],[9,9],48,[null,null,65536]],
  [26,"request-budget-limit-plus-one","unary",true,8,"WGA_METADATA_SIZE",[],[],{},[0,0,0,0],[0,0],8,[null,null,null]],
  [27,"html","stream",true,2,"WGA_NOT_GRPC_WEB",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [27,"json","stream",true,2,"WGA_NOT_GRPC_WEB",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
  [27,"grpc-web-text","stream",true,2,"WGA_NOT_GRPC_WEB",[],[],{},[0,0,0,1],[0,0],8,[null,null,null]],
];

// Parser columns: id, scenario, code, error, frames, allocations, setCalls,
// copied bytes, source chunk sizes, cancels, peak buffered bytes.
const allocationReceipts = [
  [1,"unary",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,16,5],4,33,[33],0,54],
  [2,"empty-message",0,null,[{"trailer":false,"bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,0,5,16,5],3,26,[26],0,47],
  [3,"empty-stream",0,null,[{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,16,5],2,21,[21],0,42],
  [4,"header-split-1",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,16,5],5,33,[1,32],0,53],
  [4,"header-split-2",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,16,5],5,33,[2,31],0,52],
  [4,"header-split-3",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,16,5],5,33,[3,30],0,51],
  [4,"header-split-4",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,16,5],5,33,[4,29],0,50],
  [5,"bytewise-31",0,null,[{"trailer":false,"bytes":31,"sha256":"5cd87dcf1c0b923e45e82a2e7a907d8a598b33a495423929ec0832487173f3c4"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,31,5,16,5],57,57,{"ones":57},0,37],
  [5,"bytewise-257",0,null,[{"trailer":false,"bytes":257,"sha256":"892a7c640c628b1c46f45c6c35dddee55c2e954262203d47879648c17c056887"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,257,5,16,5],283,283,{"ones":283},0,263],
  [5,"bytewise-4096",0,null,[{"trailer":false,"bytes":4096,"sha256":"95f5a4d89f6e290abb556652f7867eeb5374ebef2d4818213c74d3726eb070bb"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,4096,5,16,5],4122,4122,{"ones":4122},0,4102],
  [6,"coalesced",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":false,"bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"trailer":false,"bytes":3,"sha256":"ef8666621db3a3d1d9da83bea3dfcdd6ad8b6c0779dd08b15fff0cd09395ab02"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,0,5,3,5,16,5],7,46,[46],0,67],
  [6,"fragmented",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":false,"bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"trailer":false,"bytes":3,"sha256":"ef8666621db3a3d1d9da83bea3dfcdd6ad8b6c0779dd08b15fff0cd09395ab02"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,0,5,3,5,16,5],11,46,[14,6,3,10,13],0,34],
  [7,"seed-1",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":false,"bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"trailer":false,"bytes":3,"sha256":"ef8666621db3a3d1d9da83bea3dfcdd6ad8b6c0779dd08b15fff0cd09395ab02"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,0,5,3,5,16,5],11,46,[2,3,13,13,12,3],0,34],
  [7,"seed-12648430",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":false,"bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"trailer":false,"bytes":3,"sha256":"ef8666621db3a3d1d9da83bea3dfcdd6ad8b6c0779dd08b15fff0cd09395ab02"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,0,5,3,5,16,5],11,46,[17,2,1,14,11,1],0,35],
  [7,"seed-305419896",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":false,"bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"trailer":false,"bytes":3,"sha256":"ef8666621db3a3d1d9da83bea3dfcdd6ad8b6c0779dd08b15fff0cd09395ab02"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,0,5,3,5,16,5],13,46,[16,6,1,4,8,3,6,2],0,29],
  [7,"seed-4294967295",0,null,[{"trailer":false,"bytes":7,"sha256":"3d9a62a9d528096836ae1a1e8e675fa1da08315abed0708e1bcc3300c8a9bc15"},{"trailer":false,"bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"trailer":false,"bytes":3,"sha256":"ef8666621db3a3d1d9da83bea3dfcdd6ad8b6c0779dd08b15fff0cd09395ab02"},{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,7,5,0,5,3,5,16,5],14,46,[4,3,13,1,2,5,14,4],0,35],
  [8,"message-cap-31",0,null,[{"trailer":false,"bytes":31,"sha256":"61c60b487d1a921e0bcc9bf853dda0fb159b30bf57b2e2d2c753b00be15b5a09"}],[5,31,5],2,36,[5,31],0,67],
  [8,"message-cap-32",0,null,[{"trailer":false,"bytes":32,"sha256":"3ba3f5f43b92602683c19aee62a20342b084dd5971ddd33808d81a328879a547"}],[5,32,5],2,37,[5,32],0,69],
  [8,"message-cap-33",8,"WGA_FRAME_SIZE",[],[5],1,5,[5],1,10],
  [8,"wire-cap-31",0,null,[{"trailer":false,"bytes":31,"sha256":"61c60b487d1a921e0bcc9bf853dda0fb159b30bf57b2e2d2c753b00be15b5a09"}],[5,31,5],2,36,[5,31],0,67],
  [8,"wire-cap-32",0,null,[{"trailer":false,"bytes":32,"sha256":"3ba3f5f43b92602683c19aee62a20342b084dd5971ddd33808d81a328879a547"}],[5,32,5],2,37,[5,32],0,69],
  [8,"wire-cap-33",8,"WGA_FRAME_SIZE",[],[5],1,5,[5],1,10],
  [8,"parser-cap-32MiB-above-4MiB",0,null,[{"trailer":false,"bytes":4194305,"sha256":"a67d4f371bc774fef31bba07ed00f174673b28fa4ec35cda40bdb16d441a5d9b"}],[5,4194305,5],2,4194310,[5,4194305],0,8388615],
  [9,"uint32-max",8,"WGA_FRAME_SIZE",[],[5],1,5,[5],1,10],
  [10,"truncated-header-1",13,"WGA_TRUNCATED_FRAME",[],[5],1,1,[1],0,6],
  [10,"truncated-header-2",13,"WGA_TRUNCATED_FRAME",[],[5],1,2,[2],0,7],
  [10,"truncated-header-3",13,"WGA_TRUNCATED_FRAME",[],[5],1,3,[3],0,8],
  [10,"truncated-header-4",13,"WGA_TRUNCATED_FRAME",[],[5],1,4,[4],0,9],
  [11,"truncated-payload",13,"WGA_TRUNCATED_FRAME",[],[5,12],2,8,[8],0,25],
  [13,"identity",13,"WGA_COMPRESSED_WITH_IDENTITY",[],[5],1,5,[5],1,10],
  [13,"unknown-codec",12,"WGA_COMPRESSION_ENCODING",[],[5],1,5,[5],1,10],
  [13,"compressed-trailer",12,"WGA_COMPRESSED_TRAILER",[],[5],1,5,[5],1,10],
  [14,"duplicate-trailer",13,"WGA_FRAME_AFTER_TRAILER",[{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,16,5],3,26,[21,5],1,42],
  [15,"data-after-trailer",13,"WGA_FRAME_AFTER_TRAILER",[{"trailer":true,"bytes":16,"sha256":"ad74170f29629ae06c76be7d3e2cc684299a0f4c9bde72b5db519a0adbb5ef84"}],[5,16,5],3,26,[21,5],1,42],
];

const empty = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
  parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
const digest = length => ({ length, sha256: createHash('sha256').update('a'.repeat(length)).digest('hex') });
const idOf = number => `WIRE-${String(number).padStart(3, '0')}`;
function usage(peakBufferedBytes, calls = 1) {
  return { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: calls, peakQueuedCalls: 0, peakBufferedBytes };
}
function publicRows(mode) {
  const records = structuredClone(publicReceipts);
  for (let flag = 2; flag <= 255; flag++) if (flag !== 128 && flag !== 129) {
    records.push([12, `reserved-flag-${flag.toString(16).padStart(2, '0')}`, 'unary', true, 13, 'WGA_FRAME_FLAGS', [], [{}], {},
      [1, 1, 5, 1], [0, 0], 16, [null, null, null]]);
  }
  return records.map(([number, variant, kind, catalogMatch, code, details, decoded, initial, metadata, source, peaks, peakBytes, budgets]) => {
    const fetchCount = Number(variant !== 'request-budget-limit-plus-one'), stream = kind === 'stream';
    const type = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
    let requestHeaders = { accept: type, 'content-type': type, 'grpc-accept-encoding': 'identity,deflate,gzip',
      'grpc-encoding': 'identity', 'x-grpc-web': '1', 'x-user-agent': 'workers-grpc-adapter/0.0.0-prototype.1' };
    if (number === 22) {
      requestHeaders['x-repeat'] = 'first, second';
      if (variant.endsWith('-and-binary')) requestHeaders['trace-bin'] = 'AQI=, AwQ=';
    }
    if (variant === 'request-budget-limit') {
      requestHeaders['x-user-agent'] += ' wire-boundary'; requestHeaders['trace-bin'] = 'AQI=';
      requestHeaders['x-pad'] = digest(mode === 'cloudflare' ? 65067 : 65055);
    }
    if (!fetchCount) requestHeaders = null;
    return { id: idOf(number), variant, kind, status: 'passed', catalogMatch, fetchCount, callbackCount: Number(!stream),
      callbackCode: stream ? null : code, writeCompletions: 1, initial, statuses: [{ code, details, metadata }], decoded,
      delivered: stream || !code ? structuredClone(decoded) : [], errors: stream && code ? [code] : [],
      events: [...initial.map(() => 'metadata'), ...(stream ? [...decoded.map(() => 'data'), ...(code ? ['error'] : [])] : ['callback']), 'status'],
      source: { pulls: source[0], chunks: source[1], bytes: source[2], cancels: source[3], readerUnlocked: true },
      maxExecution: { ...empty, activePumps: Number(decoded.length > 0), parserAssemblies: Number(decoded.length > 0),
        parserAssemblyBytes: peaks[0], runtimeChunkBytes: peaks[1] },
      diagnostics: { terminal: true, fetchCount, requestBytes: 0, responseBytes: 0, timerActive: false }, execution: { ...empty },
      resources: usage(peakBytes), activeCalls: 0, requestHeaders,
      budgets: { header: budgets[0], trailer: budgets[1], request: budgets[2] }, cleanupBeforeClose: true };
  });
}
function allocationRows() {
  const records = structuredClone(allocationReceipts);
  for (let flag = 2; flag <= 255; flag++) if (flag !== 128 && flag !== 129) {
    records.push([12, `reserved-flag-${flag}`, 13, 'WGA_FRAME_FLAGS', [], [5], 1, 5, [5], 1, 10]);
  }
  return records.map(([number, scenario, code, errorId, frames, sizes, setCalls, setBytes, chunks, cancels, peak]) => {
    const pulledChunkSizes = Array.isArray(chunks) ? chunks : Array(chunks.ones).fill(1);
    return { id: idOf(number), scenario, status: 'passed', code, errorId, frames, allocUnsafeSizes: sizes,
      allocUnsafeBytes: sizes.reduce((sum, value) => sum + value, 0), setCalls, setBytes, concatCalls: 0, concatBytes: 0,
      pulls: pulledChunkSizes.length + Number(!cancels), pulledChunkSizes, cancels,
      finalParser: { parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 },
      finalResources: usage(peak, 0), readerLocked: false, spyRestored: true };
  });
}
function fixture() {
  const report = { status: 'passed', development: false, sourceBuild: false, liveCloud: false,
    incomingCloudflareTranslation: false, nativeHttp2: false, controlledPeer: true, externalRequests: 0,
    compatibilityDate: '2026-09-21', node: 'v24.1.0', miniflare: '5.20260921.0-alpha', workerd: '1.20260921.1',
    bundleSha256: 'a'.repeat(64), cleanupVerifiedBeforeDispose: true, runtimeDisposed: true, caseCount: 1476,
    runs: ['node', 'workerd'].flatMap(runtime => ['cloudflare', 'grpc-web'].map(mode => ({ runtime, mode, status: 'passed', rows: publicRows(mode) }))),
    allocation: { status: 'passed', runtime: 'node', layer: 'internal-parser', sourceBuild: false, nodeVersion: '24.1.0', spyRestored: true,
      positiveControl: { allocUnsafeSizes: [7, 4], allocUnsafeBytes: 11, setCalls: 1, setBytes: 3, concatCalls: 1, concatBytes: 4,
        copiedBytes: [5, 6, 7], concatenatedBytes: [1, 2, 3, 4], spyRestored: true }, rows: allocationRows() },
    evidence: Object.fromEntries(['scripts/test-wire-catalog.cjs', 'scripts/wire-allocation.cjs', 'scripts/wire-catalog-evidence.cjs',
      'fixtures/shared/wire-vectors.mjs', 'fixtures/shared/wire-harness.mjs', 'fixtures/shared/wire-frames.mjs',
      'fixtures/shared/wire-metadata.mjs', 'fixtures/worker/wire-catalog.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, 'b'.repeat(64)])),
    installedInputs: Object.fromEntries(['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'call.js', 'wire.js', 'compression.js', 'resources.js']
      .map(file => [`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`, 'c'.repeat(64)])) };
  report.catalogCases = catalogCases(report.runs, report.allocation); return report;
}
const row = (report, variant, run = 0) => report.runs[run].rows.find(value => value.variant === variant);
const parser = (report, scenario) => report.allocation.rows.find(value => value.scenario === scenario);
function reject(mutate, label = 'receipt mutation') {
  const report = fixture(); mutate(report);
  assert.throws(() => validateWireCatalogReport(report), /WGA_EVIDENCE_INVALID/, label);
}

test('EVIDENCE wire accepts the complete 1476 public and 286 parser receipts with two recorded policy differences', () => {
  const report = fixture(); validateWireCatalogReport(report);
  assert.equal(report.catalogCases.length, 27);
  assert.deepEqual(report.catalogCases.filter(value => !value.catalogMatch).map(value => value.id), ['WIRE-013', 'WIRE-016']);
  assert.deepEqual(report.catalogCases.find(value => value.id === 'WIRE-008'), { id: 'WIRE-008', status: 'passed', catalogMatch: true,
    runtimes: ['node', 'workerd'], modes: ['cloudflare', 'grpc-web'], scenarioCount: 96, allocationScenarioCount: 7 });
});

test('EVIDENCE wire rejects incomplete, relabelled or duplicate execution matrices and invented catalog coverage', () => {
  for (const mutate of [
    r => { r.runs.pop(); }, r => { r.runs[0].rows.pop(); }, r => { r.runs[1] = r.runs[0]; },
    r => { r.runs[0].runtime = 'native'; }, r => { r.runs[0].mode = 'automatic'; }, r => { r.runs[0].status = 'skipped'; },
    r => { r.runs[0].rows[1] = r.runs[0].rows[0]; }, r => { r.runs[0].rows[0].id = 'WIRE-999'; },
    r => { r.runs[0].rows[0].variant = 'unreviewed'; }, r => { r.runs[0].rows[0].status = 'failed'; },
    r => { r.caseCount--; }, r => { r.catalogCases[0].scenarioCount++; }, r => { r.catalogCases[0].allocationScenarioCount++; },
    r => { r.catalogCases[12].catalogMatch = true; }, r => { r.catalogCases[15].catalogMatch = true; },
    r => { r.catalogCases[22].catalogMatch = false; }, r => { r.catalogCases.pop(); },
    r => { row(r, 'supported-gzip').catalogMatch = true; }, r => { row(r, 'data-without-status').catalogMatch = true; },
    r => { row(r, 'headers-extra-padding').catalogMatch = false; },
  ]) reject(mutate);
});

test('EVIDENCE wire rejects altered bytes, callback order, terminal codes and deserialization of rejected frames', () => {
  for (const mutate of [
    r => { row(r, 'normal-unary').decoded[0].sha256 = '0'.repeat(64); },
    r => { row(r, 'normal-unary').decoded[0].length++; }, r => { row(r, 'normal-unary').delivered = []; },
    r => { row(r, 'present-zero-byte-message').decoded = []; },
    r => { row(r, '128-ordered-frames-and-trailer-in-one-chunk').decoded.reverse(); },
    r => { row(r, '128-ordered-frames-and-trailer-in-one-chunk').delivered.pop(); },
    r => { row(r, 'normal-unary').statuses.push(row(r, 'normal-unary').statuses[0]); },
    r => { row(r, 'normal-unary').callbackCount = 2; }, r => { row(r, 'normal-unary').callbackCode = 8; },
    r => { row(r, 'normal-unary').writeCompletions = 0; }, r => { row(r, 'normal-unary').events.reverse(); },
    r => { row(r, 'http-200-permission-denied').errors = []; },
    r => { row(r, 'http-200-permission-denied').events.splice(1, 1); },
    r => { row(r, 'uint32-maximum-header-without-payload').statuses[0].code = 13; },
    r => { row(r, 'grpc-minus-one-default-transport-at-limit').decoded[0].length = 4194304; },
    r => { row(r, 'malformed-gzip').decoded = row(r, 'normal-unary').decoded; },
    r => { row(r, 'gzip-decompressed-size-exceeds-grpc-cap').statuses[0].details = 'WGA_FETCH_FAILED'; },
    r => { row(r, 'data-after-trailer-coalesced').statuses[0].code = 0; },
    r => { row(r, 'http-502').statuses[0].code = 2; }, r => { row(r, 'http-504').statuses[0].code = 4; },
  ]) reject(mutate);
});

test('EVIDENCE wire rejects metadata, encoded budget and request ownership mutations', () => {
  for (const mutate of [
    r => { row(r, 'seeded-payload-and-trailer-1').statuses[0].metadata['x-vector-seed'] = ['2']; },
    r => { row(r, 'headers-only-non-ok-preserves-both-events').initial = []; },
    r => { row(r, 'trailers-comma-combined').statuses[0].metadata['trace-bin'].reverse(); },
    r => { row(r, 'trailers-google-status-details').statuses[0].metadata['grpc-status-details-bin'][0].hex += '00'; },
    r => { row(r, 'headers-korean').statuses[0].details = 'permission denied'; },
    r => { row(r, 'headers-malformed-percent').statuses[0].details = 'bad'; },
    r => { row(r, 'trailers-incomplete-utf8').statuses[0].details = '\ufffd'; },
    r => { row(r, 'headers-budget-limit').statuses[0].metadata['x-pad'][0].length--; },
    r => { row(r, 'trailers-budget-limit').budgets.trailer--; },
    r => { row(r, 'headers-budget-limit-plus-one').budgets.header = 65536; },
    r => { row(r, 'request-budget-limit').requestHeaders['x-pad'].sha256 = 'a'.repeat(64); },
    r => { row(r, 'request-budget-limit', 1).requestHeaders['content-type'] = 'application/grpc-web'; },
    r => { row(r, 'request-budget-limit-plus-one').fetchCount = 1; },
    r => { row(r, 'request-repeated-text').requestHeaders['x-repeat'] = 'first'; },
    r => { row(r, 'request-repeated-text-and-binary').requestHeaders['trace-bin'] = 'AwQ=, AQI='; },
    r => { row(r, 'headers-extra-padding').statuses[0].code = 7; },
  ]) reject(mutate);
});

test('EVIDENCE wire requires actual source disposal, bounded owners and pre-close resource recovery', () => {
  for (const key of Object.keys(empty)) reject(r => { row(r, 'normal-unary').execution[key] = 1; }, key);
  for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) reject(r => { row(r, 'normal-unary').resources[key] = 1; }, key);
  for (const variant of ['html', 'json', 'grpc-web-text', 'headers-alphabet', 'headers-budget-limit-plus-one']) {
    reject(r => { row(r, variant).source.cancels = 0; }, variant);
    reject(r => { row(r, variant).source.pulls = 1; }, variant);
  }
  for (const mutate of [
    r => { row(r, 'normal-unary').cleanupBeforeClose = false; }, r => { row(r, 'normal-unary').source.readerUnlocked = false; },
    r => { row(r, 'normal-unary').activeCalls = 1; }, r => { row(r, 'normal-unary').diagnostics.timerActive = true; },
    r => { row(r, 'normal-unary').diagnostics.requestBytes = 6; }, r => { row(r, 'normal-unary').maxExecution.activePumps = 0; },
    r => { row(r, 'normal-unary').maxExecution.parserAssemblies = 2; },
    r => { row(r, 'normal-unary').maxExecution.runtimeChunkBytes = 40000000; },
    r => { row(r, 'normal-unary').resources.peakBufferedBytes = 50000000; },
    r => { row(r, 'uint32-maximum-header-without-payload').source.bytes = 4294967295; },
    r => { row(r, 'grpc-default-four-mib-above-limit').source.chunks = 2; },
    r => { row(r, 'every-response-byte-separate').source.chunks = 1; },
    r => { row(r, '128-ordered-frames-and-trailer-in-one-chunk').source.chunks = 128; },
    r => { row(r, 'seeded-payload-and-trailer-1', 2).source.bytes++; },
  ]) reject(mutate);
});

test('EVIDENCE wire allocation calibration rejects extra allocation, concatenation, copying or premature payload reads', () => {
  for (const mutate of [
    r => { r.allocation.rows.pop(); }, r => { r.allocation.rows[1] = r.allocation.rows[0]; },
    r => { r.allocation.runtime = 'workerd'; }, r => { r.allocation.layer = 'public'; },
    r => { r.allocation.spyRestored = false; }, r => { r.allocation.positiveControl.spyRestored = false; },
    r => { r.allocation.positiveControl.concatCalls = 0; }, r => { r.allocation.positiveControl.setBytes = 0; },
    r => { r.allocation.positiveControl.allocUnsafeSizes = [4]; },
    r => { r.allocation.positiveControl.concatenatedBytes.reverse(); },
    r => { parser(r, 'uint32-max').allocUnsafeSizes.push(4294967295); },
    r => { parser(r, 'message-cap-33').allocUnsafeBytes = 38; },
    r => { parser(r, 'message-cap-33').pulledChunkSizes.push(33); },
    r => { parser(r, 'wire-cap-33').pulls = 2; }, r => { parser(r, 'wire-cap-33').cancels = 0; },
    r => { parser(r, 'bytewise-4096').concatCalls = 1; }, r => { parser(r, 'bytewise-4096').concatBytes = 4096; },
    r => { parser(r, 'bytewise-4096').setBytes *= 2; }, r => { parser(r, 'bytewise-4096').setCalls--; },
    r => { parser(r, 'bytewise-4096').allocUnsafeSizes.push(1); },
    r => { parser(r, 'unary').frames[0].sha256 = '0'.repeat(64); },
    r => { parser(r, 'empty-message').frames.shift(); }, r => { parser(r, 'coalesced').frames.reverse(); },
    r => { parser(r, 'seed-1').pulledChunkSizes.reverse(); },
    r => { parser(r, 'reserved-flag-255').errorId = 'WGA_TRUNCATED_FRAME'; },
    r => { parser(r, 'compressed-trailer').code = 13; }, r => { parser(r, 'truncated-payload').frames.push({}); },
    r => { parser(r, 'duplicate-trailer').allocUnsafeSizes.push(99); },
    r => { parser(r, 'data-after-trailer').cancels = 0; },
    r => { parser(r, 'unary').readerLocked = true; }, r => { parser(r, 'unary').finalParser.parserAssemblyBytes = 5; },
    r => { parser(r, 'unary').finalResources.bufferedBytes = 5; },
    r => { parser(r, 'unary').finalResources.peakActiveCalls = 1; },
  ]) reject(mutate);
});

test('EVIDENCE wire requires source and installed provenance and rejects development or live-platform claims', () => {
  for (const mutate of [
    r => { r.status = 'development-passed'; }, r => { r.development = true; }, r => { r.liveCloud = true; },
    r => { r.incomingCloudflareTranslation = true; }, r => { r.nativeHttp2 = true; }, r => { r.controlledPeer = false; },
    r => { r.externalRequests = 1; }, r => { r.cleanupVerifiedBeforeDispose = false; }, r => { r.runtimeDisposed = false; },
    r => { r.compatibilityDate = '2025-01-01'; }, r => { r.bundleSha256 = 'missing'; }, r => { r.workerd = ''; },
    r => { r.evidence = {}; }, r => { delete r.evidence['scripts/wire-allocation.cjs']; },
    r => { r.installedInputs = {}; }, r => { delete r.installedInputs['fixtures/worker/node_modules/@grpc/grpc-js/dist/wire.js']; },
    r => { r.installedInputs['fixtures/worker/node_modules/@grpc/grpc-js/../bad.js'] = 'a'.repeat(64); },
    r => { r.installedInputs['outside.js'] = 'a'.repeat(64); },
  ]) reject(mutate);
  const report = fixture(); report.sourceBuild = true; report.allocation.sourceBuild = true; report.installedInputs = {};
  assert.throws(() => validateWireCatalogReport(report), /WGA_EVIDENCE_INVALID/);
  validateWireCatalogReport(report, { allowSourceBuild: true });
  parser(report, 'unary').setBytes++;
  assert.throws(() => validateWireCatalogReport(report, { allowSourceBuild: true }), /WGA_EVIDENCE_INVALID/);
});
