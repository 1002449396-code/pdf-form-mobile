// fontkit as a module. The package's ES build imports "pako" by bare name,
// which neither a browser nor this app can resolve; the UMD build is
// self-contained and, imported as a module, attaches itself to `self`.
import "../vendor/pdf-lib/fontkit.umd.min.js";

export default self.fontkit;
