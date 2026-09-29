// Expression receivers (upstream #2032 torture.js addition, fork corpus copy).
// Transparent wrappers peel to the receiver; untyped expression receivers
// (call results, nullish, subscript, arrow IIFE) emit no bare-name ref.
async function exprReceivers(x) {
  (await list()).map(g);
  (x).run();
  (a ?? b).map(g);
  f().list.map(g);
  (() => 1).call(null);
  this.a.b.run();
  new Runner().go();
}
