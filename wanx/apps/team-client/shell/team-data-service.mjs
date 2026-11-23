import {createRequire as teamDataRequire} from "node:module";const require=teamDataRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../builder/node_modules/semver/internal/constants.js
var require_constants = __commonJS({
  "../builder/node_modules/semver/internal/constants.js"(exports, module) {
    "use strict";
    var SEMVER_SPEC_VERSION = "2.0.0";
    var MAX_LENGTH = 256;
    var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || /* istanbul ignore next */
    9007199254740991;
    var MAX_SAFE_COMPONENT_LENGTH = 16;
    var MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6;
    var RELEASE_TYPES = [
      "major",
      "premajor",
      "minor",
      "preminor",
      "patch",
      "prepatch",
      "prerelease"
    ];
    module.exports = {
      MAX_LENGTH,
      MAX_SAFE_COMPONENT_LENGTH,
      MAX_SAFE_BUILD_LENGTH,
      MAX_SAFE_INTEGER,
      RELEASE_TYPES,
      SEMVER_SPEC_VERSION,
      FLAG_INCLUDE_PRERELEASE: 1,
      FLAG_LOOSE: 2
    };
  }
});

// ../builder/node_modules/semver/internal/debug.js
var require_debug = __commonJS({
  "../builder/node_modules/semver/internal/debug.js"(exports, module) {
    "use strict";
    var debug = typeof process === "object" && process.env && process.env.NODE_DEBUG && /\bsemver\b/i.test(process.env.NODE_DEBUG) ? (...args) => console.error("SEMVER", ...args) : () => {
    };
    module.exports = debug;
  }
});

// ../builder/node_modules/semver/internal/re.js
var require_re = __commonJS({
  "../builder/node_modules/semver/internal/re.js"(exports, module) {
    "use strict";
    var {
      MAX_SAFE_COMPONENT_LENGTH,
      MAX_SAFE_BUILD_LENGTH,
      MAX_LENGTH
    } = require_constants();
    var debug = require_debug();
    exports = module.exports = {};
    var re = exports.re = [];
    var safeRe = exports.safeRe = [];
    var src = exports.src = [];
    var safeSrc = exports.safeSrc = [];
    var t = exports.t = {};
    var R = 0;
    var LETTERDASHNUMBER = "[a-zA-Z0-9-]";
    var safeRegexReplacements = [
      ["\\s", 1],
      ["\\d", MAX_LENGTH],
      [LETTERDASHNUMBER, MAX_SAFE_BUILD_LENGTH]
    ];
    var makeSafeRegex = (value) => {
      for (const [token, max] of safeRegexReplacements) {
        value = value.split(`${token}*`).join(`${token}{0,${max}}`).split(`${token}+`).join(`${token}{1,${max}}`);
      }
      return value;
    };
    var createToken = (name, value, isGlobal) => {
      const safe = makeSafeRegex(value);
      const index = R++;
      debug(name, index, value);
      t[name] = index;
      src[index] = value;
      safeSrc[index] = safe;
      re[index] = new RegExp(value, isGlobal ? "g" : void 0);
      safeRe[index] = new RegExp(safe, isGlobal ? "g" : void 0);
    };
    createToken("NUMERICIDENTIFIER", "0|[1-9]\\d*");
    createToken("NUMERICIDENTIFIERLOOSE", "\\d+");
    createToken("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${LETTERDASHNUMBER}*`);
    createToken("MAINVERSION", `(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})`);
    createToken("MAINVERSIONLOOSE", `(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})`);
    createToken("PRERELEASEIDENTIFIER", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIER]})`);
    createToken("PRERELEASEIDENTIFIERLOOSE", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIERLOOSE]})`);
    createToken("PRERELEASE", `(?:-(${src[t.PRERELEASEIDENTIFIER]}(?:\\.${src[t.PRERELEASEIDENTIFIER]})*))`);
    createToken("PRERELEASELOOSE", `(?:-?(${src[t.PRERELEASEIDENTIFIERLOOSE]}(?:\\.${src[t.PRERELEASEIDENTIFIERLOOSE]})*))`);
    createToken("BUILDIDENTIFIER", `${LETTERDASHNUMBER}+`);
    createToken("BUILD", `(?:\\+(${src[t.BUILDIDENTIFIER]}(?:\\.${src[t.BUILDIDENTIFIER]})*))`);
    createToken("FULLPLAIN", `v?${src[t.MAINVERSION]}${src[t.PRERELEASE]}?${src[t.BUILD]}?`);
    createToken("FULL", `^${src[t.FULLPLAIN]}$`);
    createToken("LOOSEPLAIN", `[v=\\s]*${src[t.MAINVERSIONLOOSE]}${src[t.PRERELEASELOOSE]}?${src[t.BUILD]}?`);
    createToken("LOOSE", `^${src[t.LOOSEPLAIN]}$`);
    createToken("GTLT", "((?:<|>)?=?)");
    createToken("XRANGEIDENTIFIERLOOSE", `${src[t.NUMERICIDENTIFIERLOOSE]}|x|X|\\*`);
    createToken("XRANGEIDENTIFIER", `${src[t.NUMERICIDENTIFIER]}|x|X|\\*`);
    createToken("XRANGEPLAIN", `[v=\\s]*(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:${src[t.PRERELEASE]})?${src[t.BUILD]}?)?)?`);
    createToken("XRANGEPLAINLOOSE", `[v=\\s]*(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:${src[t.PRERELEASELOOSE]})?${src[t.BUILD]}?)?)?`);
    createToken("XRANGE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAIN]}$`);
    createToken("XRANGELOOSE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("COERCEPLAIN", `${"(^|[^\\d])(\\d{1,"}${MAX_SAFE_COMPONENT_LENGTH}})(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?`);
    createToken("COERCE", `${src[t.COERCEPLAIN]}(?:$|[^\\d])`);
    createToken("COERCEFULL", src[t.COERCEPLAIN] + `(?:${src[t.PRERELEASE]})?(?:${src[t.BUILD]})?(?:$|[^\\d])`);
    createToken("COERCERTL", src[t.COERCE], true);
    createToken("COERCERTLFULL", src[t.COERCEFULL], true);
    createToken("LONETILDE", "(?:~>?)");
    createToken("TILDETRIM", `(\\s*)${src[t.LONETILDE]}\\s+`, true);
    exports.tildeTrimReplace = "$1~";
    createToken("TILDE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAIN]}$`);
    createToken("TILDELOOSE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("LONECARET", "(?:\\^)");
    createToken("CARETTRIM", `(\\s*)${src[t.LONECARET]}\\s+`, true);
    exports.caretTrimReplace = "$1^";
    createToken("CARET", `^${src[t.LONECARET]}${src[t.XRANGEPLAIN]}$`);
    createToken("CARETLOOSE", `^${src[t.LONECARET]}${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("COMPARATORLOOSE", `^${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]})$|^$`);
    createToken("COMPARATOR", `^${src[t.GTLT]}\\s*(${src[t.FULLPLAIN]})$|^$`);
    createToken("COMPARATORTRIM", `(\\s*)${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]}|${src[t.XRANGEPLAIN]})`, true);
    exports.comparatorTrimReplace = "$1$2$3";
    createToken("HYPHENRANGE", `^\\s*(${src[t.XRANGEPLAIN]})\\s+-\\s+(${src[t.XRANGEPLAIN]})\\s*$`);
    createToken("HYPHENRANGELOOSE", `^\\s*(${src[t.XRANGEPLAINLOOSE]})\\s+-\\s+(${src[t.XRANGEPLAINLOOSE]})\\s*$`);
    createToken("STAR", "(<|>)?=?\\s*\\*");
    createToken("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$");
    createToken("GTE0PRE", "^\\s*>=\\s*0\\.0\\.0-0\\s*$");
  }
});

// ../builder/node_modules/semver/internal/parse-options.js
var require_parse_options = __commonJS({
  "../builder/node_modules/semver/internal/parse-options.js"(exports, module) {
    "use strict";
    var looseOption = Object.freeze({ loose: true });
    var emptyOpts = Object.freeze({});
    var parseOptions = (options) => {
      if (!options) {
        return emptyOpts;
      }
      if (typeof options !== "object") {
        return looseOption;
      }
      return options;
    };
    module.exports = parseOptions;
  }
});

// ../builder/node_modules/semver/internal/identifiers.js
var require_identifiers = __commonJS({
  "../builder/node_modules/semver/internal/identifiers.js"(exports, module) {
    "use strict";
    var numeric = /^[0-9]+$/;
    var compareIdentifiers = (a, b) => {
      if (typeof a === "number" && typeof b === "number") {
        return a === b ? 0 : a < b ? -1 : 1;
      }
      const anum = numeric.test(a);
      const bnum = numeric.test(b);
      if (anum && bnum) {
        a = +a;
        b = +b;
      }
      return a === b ? 0 : anum && !bnum ? -1 : bnum && !anum ? 1 : a < b ? -1 : 1;
    };
    var rcompareIdentifiers = (a, b) => compareIdentifiers(b, a);
    module.exports = {
      compareIdentifiers,
      rcompareIdentifiers
    };
  }
});

// ../builder/node_modules/semver/classes/semver.js
var require_semver = __commonJS({
  "../builder/node_modules/semver/classes/semver.js"(exports, module) {
    "use strict";
    var debug = require_debug();
    var { MAX_LENGTH, MAX_SAFE_INTEGER } = require_constants();
    var { safeRe: re, t } = require_re();
    var parseOptions = require_parse_options();
    var { compareIdentifiers } = require_identifiers();
    var isPrereleaseIdentifier = (prerelease, identifier) => {
      const identifiers = identifier.split(".");
      if (identifiers.length > prerelease.length) {
        return false;
      }
      for (let i = 0; i < identifiers.length; i++) {
        if (compareIdentifiers(prerelease[i], identifiers[i]) !== 0) {
          return false;
        }
      }
      return true;
    };
    var SemVer = class _SemVer {
      constructor(version, options) {
        options = parseOptions(options);
        if (version instanceof _SemVer) {
          if (version.loose === !!options.loose && version.includePrerelease === !!options.includePrerelease) {
            return version;
          } else {
            version = version.version;
          }
        } else if (typeof version !== "string") {
          throw new TypeError(`Invalid version. Must be a string. Got type "${typeof version}".`);
        }
        if (version.length > MAX_LENGTH) {
          throw new TypeError(
            `version is longer than ${MAX_LENGTH} characters`
          );
        }
        debug("SemVer", version, options);
        this.options = options;
        this.loose = !!options.loose;
        this.includePrerelease = !!options.includePrerelease;
        const m = version.trim().match(options.loose ? re[t.LOOSE] : re[t.FULL]);
        if (!m) {
          throw new TypeError(`Invalid Version: ${version}`);
        }
        this.raw = version;
        this.major = +m[1];
        this.minor = +m[2];
        this.patch = +m[3];
        if (this.major > MAX_SAFE_INTEGER || this.major < 0) {
          throw new TypeError("Invalid major version");
        }
        if (this.minor > MAX_SAFE_INTEGER || this.minor < 0) {
          throw new TypeError("Invalid minor version");
        }
        if (this.patch > MAX_SAFE_INTEGER || this.patch < 0) {
          throw new TypeError("Invalid patch version");
        }
        if (!m[4]) {
          this.prerelease = [];
        } else {
          this.prerelease = m[4].split(".").map((id2) => {
            if (/^[0-9]+$/.test(id2)) {
              const num = +id2;
              if (num >= 0 && num < MAX_SAFE_INTEGER) {
                return num;
              }
            }
            return id2;
          });
        }
        this.build = m[5] ? m[5].split(".") : [];
        this.format();
      }
      format() {
        this.version = `${this.major}.${this.minor}.${this.patch}`;
        if (this.prerelease.length) {
          this.version += `-${this.prerelease.join(".")}`;
        }
        return this.version;
      }
      toString() {
        return this.version;
      }
      compare(other) {
        debug("SemVer.compare", this.version, this.options, other);
        if (!(other instanceof _SemVer)) {
          if (typeof other === "string" && other === this.version) {
            return 0;
          }
          other = new _SemVer(other, this.options);
        }
        if (other.version === this.version) {
          return 0;
        }
        return this.compareMain(other) || this.comparePre(other);
      }
      compareMain(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        if (this.major < other.major) {
          return -1;
        }
        if (this.major > other.major) {
          return 1;
        }
        if (this.minor < other.minor) {
          return -1;
        }
        if (this.minor > other.minor) {
          return 1;
        }
        if (this.patch < other.patch) {
          return -1;
        }
        if (this.patch > other.patch) {
          return 1;
        }
        return 0;
      }
      comparePre(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        if (this.prerelease.length && !other.prerelease.length) {
          return -1;
        } else if (!this.prerelease.length && other.prerelease.length) {
          return 1;
        } else if (!this.prerelease.length && !other.prerelease.length) {
          return 0;
        }
        let i = 0;
        do {
          const a = this.prerelease[i];
          const b = other.prerelease[i];
          debug("prerelease compare", i, a, b);
          if (a === void 0 && b === void 0) {
            return 0;
          } else if (b === void 0) {
            return 1;
          } else if (a === void 0) {
            return -1;
          } else if (a === b) {
            continue;
          } else {
            return compareIdentifiers(a, b);
          }
        } while (++i);
      }
      compareBuild(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        let i = 0;
        do {
          const a = this.build[i];
          const b = other.build[i];
          debug("build compare", i, a, b);
          if (a === void 0 && b === void 0) {
            return 0;
          } else if (b === void 0) {
            return 1;
          } else if (a === void 0) {
            return -1;
          } else if (a === b) {
            continue;
          } else {
            return compareIdentifiers(a, b);
          }
        } while (++i);
      }
      // preminor will bump the version up to the next minor release, and immediately
      // down to pre-release. premajor and prepatch work the same way.
      inc(release, identifier, identifierBase) {
        if (release.startsWith("pre")) {
          if (!identifier && identifierBase === false) {
            throw new Error("invalid increment argument: identifier is empty");
          }
          if (identifier) {
            const match = `-${identifier}`.match(this.options.loose ? re[t.PRERELEASELOOSE] : re[t.PRERELEASE]);
            if (!match || match[1] !== identifier) {
              throw new Error(`invalid identifier: ${identifier}`);
            }
          }
        }
        switch (release) {
          case "premajor":
            this.prerelease.length = 0;
            this.patch = 0;
            this.minor = 0;
            this.major++;
            this.inc("pre", identifier, identifierBase);
            break;
          case "preminor":
            this.prerelease.length = 0;
            this.patch = 0;
            this.minor++;
            this.inc("pre", identifier, identifierBase);
            break;
          case "prepatch":
            this.prerelease.length = 0;
            this.inc("patch", identifier, identifierBase);
            this.inc("pre", identifier, identifierBase);
            break;
          // If the input is a non-prerelease version, this acts the same as
          // prepatch.
          case "prerelease":
            if (this.prerelease.length === 0) {
              this.inc("patch", identifier, identifierBase);
            }
            this.inc("pre", identifier, identifierBase);
            break;
          case "release":
            if (this.prerelease.length === 0) {
              throw new Error(`version ${this.raw} is not a prerelease`);
            }
            this.prerelease.length = 0;
            break;
          case "major":
            if (this.minor !== 0 || this.patch !== 0 || this.prerelease.length === 0) {
              this.major++;
            }
            this.minor = 0;
            this.patch = 0;
            this.prerelease = [];
            break;
          case "minor":
            if (this.patch !== 0 || this.prerelease.length === 0) {
              this.minor++;
            }
            this.patch = 0;
            this.prerelease = [];
            break;
          case "patch":
            if (this.prerelease.length === 0) {
              this.patch++;
            }
            this.prerelease = [];
            break;
          // This probably shouldn't be used publicly.
          // 1.0.0 'pre' would become 1.0.0-0 which is the wrong direction.
          case "pre": {
            const base = Number(identifierBase) ? 1 : 0;
            if (this.prerelease.length === 0) {
              this.prerelease = [base];
            } else {
              let i = this.prerelease.length;
              while (--i >= 0) {
                if (typeof this.prerelease[i] === "number") {
                  this.prerelease[i]++;
                  i = -2;
                }
              }
              if (i === -1) {
                if (identifier === this.prerelease.join(".") && identifierBase === false) {
                  throw new Error("invalid increment argument: identifier already exists");
                }
                this.prerelease.push(base);
              }
            }
            if (identifier) {
              let prerelease = [identifier, base];
              if (identifierBase === false) {
                prerelease = [identifier];
              }
              if (isPrereleaseIdentifier(this.prerelease, identifier)) {
                const prereleaseBase = this.prerelease[identifier.split(".").length];
                if (isNaN(prereleaseBase)) {
                  this.prerelease = prerelease;
                }
              } else {
                this.prerelease = prerelease;
              }
            }
            break;
          }
          default:
            throw new Error(`invalid increment argument: ${release}`);
        }
        this.raw = this.format();
        if (this.build.length) {
          this.raw += `+${this.build.join(".")}`;
        }
        return this;
      }
    };
    module.exports = SemVer;
  }
});

// ../builder/node_modules/semver/functions/parse.js
var require_parse = __commonJS({
  "../builder/node_modules/semver/functions/parse.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var parse = (version, options, throwErrors = false) => {
      if (version instanceof SemVer) {
        return version;
      }
      try {
        return new SemVer(version, options);
      } catch (er) {
        if (!throwErrors) {
          return null;
        }
        throw er;
      }
    };
    module.exports = parse;
  }
});

// ../builder/node_modules/semver/functions/valid.js
var require_valid = __commonJS({
  "../builder/node_modules/semver/functions/valid.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var valid = (version, options) => {
      const v = parse(version, options);
      return v ? v.version : null;
    };
    module.exports = valid;
  }
});

// ../builder/node_modules/semver/functions/clean.js
var require_clean = __commonJS({
  "../builder/node_modules/semver/functions/clean.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var clean = (version, options) => {
      const s = parse(version.trim().replace(/^[=v]+/, ""), options);
      return s ? s.version : null;
    };
    module.exports = clean;
  }
});

// ../builder/node_modules/semver/functions/inc.js
var require_inc = __commonJS({
  "../builder/node_modules/semver/functions/inc.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var inc = (version, release, options, identifier, identifierBase) => {
      if (typeof options === "string") {
        identifierBase = identifier;
        identifier = options;
        options = void 0;
      }
      try {
        return new SemVer(
          version instanceof SemVer ? version.version : version,
          options
        ).inc(release, identifier, identifierBase).version;
      } catch (er) {
        return null;
      }
    };
    module.exports = inc;
  }
});

// ../builder/node_modules/semver/functions/diff.js
var require_diff = __commonJS({
  "../builder/node_modules/semver/functions/diff.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var diff = (version1, version2) => {
      const v1 = parse(version1, null, true);
      const v2 = parse(version2, null, true);
      const comparison = v1.compare(v2);
      if (comparison === 0) {
        return null;
      }
      const v1Higher = comparison > 0;
      const highVersion = v1Higher ? v1 : v2;
      const lowVersion = v1Higher ? v2 : v1;
      const highHasPre = !!highVersion.prerelease.length;
      const lowHasPre = !!lowVersion.prerelease.length;
      if (lowHasPre && !highHasPre) {
        if (!lowVersion.patch && !lowVersion.minor) {
          return "major";
        }
        if (lowVersion.compareMain(highVersion) === 0) {
          if (lowVersion.minor && !lowVersion.patch) {
            return "minor";
          }
          return "patch";
        }
      }
      const prefix = highHasPre ? "pre" : "";
      if (v1.major !== v2.major) {
        return prefix + "major";
      }
      if (v1.minor !== v2.minor) {
        return prefix + "minor";
      }
      if (v1.patch !== v2.patch) {
        return prefix + "patch";
      }
      return "prerelease";
    };
    module.exports = diff;
  }
});

// ../builder/node_modules/semver/functions/major.js
var require_major = __commonJS({
  "../builder/node_modules/semver/functions/major.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var major = (a, loose) => new SemVer(a, loose).major;
    module.exports = major;
  }
});

// ../builder/node_modules/semver/functions/minor.js
var require_minor = __commonJS({
  "../builder/node_modules/semver/functions/minor.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var minor = (a, loose) => new SemVer(a, loose).minor;
    module.exports = minor;
  }
});

// ../builder/node_modules/semver/functions/patch.js
var require_patch = __commonJS({
  "../builder/node_modules/semver/functions/patch.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var patch = (a, loose) => new SemVer(a, loose).patch;
    module.exports = patch;
  }
});

// ../builder/node_modules/semver/functions/prerelease.js
var require_prerelease = __commonJS({
  "../builder/node_modules/semver/functions/prerelease.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var prerelease = (version, options) => {
      const parsed = parse(version, options);
      return parsed && parsed.prerelease.length ? parsed.prerelease : null;
    };
    module.exports = prerelease;
  }
});

// ../builder/node_modules/semver/functions/compare.js
var require_compare = __commonJS({
  "../builder/node_modules/semver/functions/compare.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var compare = (a, b, loose) => new SemVer(a, loose).compare(new SemVer(b, loose));
    module.exports = compare;
  }
});

// ../builder/node_modules/semver/functions/rcompare.js
var require_rcompare = __commonJS({
  "../builder/node_modules/semver/functions/rcompare.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var rcompare = (a, b, loose) => compare(b, a, loose);
    module.exports = rcompare;
  }
});

// ../builder/node_modules/semver/functions/compare-loose.js
var require_compare_loose = __commonJS({
  "../builder/node_modules/semver/functions/compare-loose.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var compareLoose = (a, b) => compare(a, b, true);
    module.exports = compareLoose;
  }
});

// ../builder/node_modules/semver/functions/compare-build.js
var require_compare_build = __commonJS({
  "../builder/node_modules/semver/functions/compare-build.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var compareBuild = (a, b, loose) => {
      const versionA = new SemVer(a, loose);
      const versionB = new SemVer(b, loose);
      return versionA.compare(versionB) || versionA.compareBuild(versionB);
    };
    module.exports = compareBuild;
  }
});

// ../builder/node_modules/semver/functions/sort.js
var require_sort = __commonJS({
  "../builder/node_modules/semver/functions/sort.js"(exports, module) {
    "use strict";
    var compareBuild = require_compare_build();
    var sort = (list, loose) => list.sort((a, b) => compareBuild(a, b, loose));
    module.exports = sort;
  }
});

// ../builder/node_modules/semver/functions/rsort.js
var require_rsort = __commonJS({
  "../builder/node_modules/semver/functions/rsort.js"(exports, module) {
    "use strict";
    var compareBuild = require_compare_build();
    var rsort = (list, loose) => list.sort((a, b) => compareBuild(b, a, loose));
    module.exports = rsort;
  }
});

// ../builder/node_modules/semver/functions/gt.js
var require_gt = __commonJS({
  "../builder/node_modules/semver/functions/gt.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var gt = (a, b, loose) => compare(a, b, loose) > 0;
    module.exports = gt;
  }
});

// ../builder/node_modules/semver/functions/lt.js
var require_lt = __commonJS({
  "../builder/node_modules/semver/functions/lt.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var lt = (a, b, loose) => compare(a, b, loose) < 0;
    module.exports = lt;
  }
});

// ../builder/node_modules/semver/functions/eq.js
var require_eq = __commonJS({
  "../builder/node_modules/semver/functions/eq.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var eq = (a, b, loose) => compare(a, b, loose) === 0;
    module.exports = eq;
  }
});

// ../builder/node_modules/semver/functions/neq.js
var require_neq = __commonJS({
  "../builder/node_modules/semver/functions/neq.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var neq = (a, b, loose) => compare(a, b, loose) !== 0;
    module.exports = neq;
  }
});

// ../builder/node_modules/semver/functions/gte.js
var require_gte = __commonJS({
  "../builder/node_modules/semver/functions/gte.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var gte = (a, b, loose) => compare(a, b, loose) >= 0;
    module.exports = gte;
  }
});

// ../builder/node_modules/semver/functions/lte.js
var require_lte = __commonJS({
  "../builder/node_modules/semver/functions/lte.js"(exports, module) {
    "use strict";
    var compare = require_compare();
    var lte = (a, b, loose) => compare(a, b, loose) <= 0;
    module.exports = lte;
  }
});

// ../builder/node_modules/semver/functions/cmp.js
var require_cmp = __commonJS({
  "../builder/node_modules/semver/functions/cmp.js"(exports, module) {
    "use strict";
    var eq = require_eq();
    var neq = require_neq();
    var gt = require_gt();
    var gte = require_gte();
    var lt = require_lt();
    var lte = require_lte();
    var cmp = (a, op, b, loose) => {
      switch (op) {
        case "===":
          if (typeof a === "object") {
            a = a.version;
          }
          if (typeof b === "object") {
            b = b.version;
          }
          return a === b;
        case "!==":
          if (typeof a === "object") {
            a = a.version;
          }
          if (typeof b === "object") {
            b = b.version;
          }
          return a !== b;
        case "":
        case "=":
        case "==":
          return eq(a, b, loose);
        case "!=":
          return neq(a, b, loose);
        case ">":
          return gt(a, b, loose);
        case ">=":
          return gte(a, b, loose);
        case "<":
          return lt(a, b, loose);
        case "<=":
          return lte(a, b, loose);
        default:
          throw new TypeError(`Invalid operator: ${op}`);
      }
    };
    module.exports = cmp;
  }
});

// ../builder/node_modules/semver/functions/coerce.js
var require_coerce = __commonJS({
  "../builder/node_modules/semver/functions/coerce.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var parse = require_parse();
    var { safeRe: re, t } = require_re();
    var coerce = (version, options) => {
      if (version instanceof SemVer) {
        return version;
      }
      if (typeof version === "number") {
        version = String(version);
      }
      if (typeof version !== "string") {
        return null;
      }
      options = options || {};
      let match = null;
      if (!options.rtl) {
        match = version.match(options.includePrerelease ? re[t.COERCEFULL] : re[t.COERCE]);
      } else {
        const coerceRtlRegex = options.includePrerelease ? re[t.COERCERTLFULL] : re[t.COERCERTL];
        let next;
        while ((next = coerceRtlRegex.exec(version)) && (!match || match.index + match[0].length !== version.length)) {
          if (!match || next.index + next[0].length !== match.index + match[0].length) {
            match = next;
          }
          coerceRtlRegex.lastIndex = next.index + next[1].length + next[2].length;
        }
        coerceRtlRegex.lastIndex = -1;
      }
      if (match === null) {
        return null;
      }
      const major = match[2];
      const minor = match[3] || "0";
      const patch = match[4] || "0";
      const prerelease = options.includePrerelease && match[5] ? `-${match[5]}` : "";
      const build = options.includePrerelease && match[6] ? `+${match[6]}` : "";
      return parse(`${major}.${minor}.${patch}${prerelease}${build}`, options);
    };
    module.exports = coerce;
  }
});

// ../builder/node_modules/semver/functions/truncate.js
var require_truncate = __commonJS({
  "../builder/node_modules/semver/functions/truncate.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var constants = require_constants();
    var SemVer = require_semver();
    var truncate = (version, truncation, options) => {
      if (!constants.RELEASE_TYPES.includes(truncation)) {
        return null;
      }
      const clonedVersion = cloneInputVersion(version, options);
      return clonedVersion && doTruncation(clonedVersion, truncation);
    };
    var cloneInputVersion = (version, options) => {
      const versionStringToParse = version instanceof SemVer ? version.version : version;
      return parse(versionStringToParse, options);
    };
    var doTruncation = (version, truncation) => {
      if (isPrerelease(truncation)) {
        return version.version;
      }
      version.prerelease = [];
      switch (truncation) {
        case "major":
          version.minor = 0;
          version.patch = 0;
          break;
        case "minor":
          version.patch = 0;
          break;
      }
      return version.format();
    };
    var isPrerelease = (type) => {
      return type.startsWith("pre");
    };
    module.exports = truncate;
  }
});

// ../builder/node_modules/semver/internal/lrucache.js
var require_lrucache = __commonJS({
  "../builder/node_modules/semver/internal/lrucache.js"(exports, module) {
    "use strict";
    var LRUCache = class {
      constructor() {
        this.max = 1e3;
        this.map = /* @__PURE__ */ new Map();
      }
      get(key) {
        const value = this.map.get(key);
        if (value === void 0) {
          return void 0;
        } else {
          this.map.delete(key);
          this.map.set(key, value);
          return value;
        }
      }
      delete(key) {
        return this.map.delete(key);
      }
      set(key, value) {
        const deleted = this.delete(key);
        if (!deleted && value !== void 0) {
          if (this.map.size >= this.max) {
            const firstKey = this.map.keys().next().value;
            this.delete(firstKey);
          }
          this.map.set(key, value);
        }
        return this;
      }
    };
    module.exports = LRUCache;
  }
});

// ../builder/node_modules/semver/classes/range.js
var require_range = __commonJS({
  "../builder/node_modules/semver/classes/range.js"(exports, module) {
    "use strict";
    var SPACE_CHARACTERS = /\s+/g;
    var Range = class _Range {
      constructor(range, options) {
        options = parseOptions(options);
        if (range instanceof _Range) {
          if (range.loose === !!options.loose && range.includePrerelease === !!options.includePrerelease) {
            return range;
          } else {
            return new _Range(range.raw, options);
          }
        }
        if (range instanceof Comparator) {
          this.raw = range.value;
          this.set = [[range]];
          this.formatted = void 0;
          return this;
        }
        this.options = options;
        this.loose = !!options.loose;
        this.includePrerelease = !!options.includePrerelease;
        this.raw = range.trim().replace(SPACE_CHARACTERS, " ");
        this.set = this.raw.split("||").map((r) => this.parseRange(r.trim())).filter((c) => c.length);
        if (!this.set.length) {
          throw new TypeError(`Invalid SemVer Range: ${this.raw}`);
        }
        if (this.set.length > 1) {
          const first = this.set[0];
          this.set = this.set.filter((c) => !isNullSet(c[0]));
          if (this.set.length === 0) {
            this.set = [first];
          } else if (this.set.length > 1) {
            for (const c of this.set) {
              if (c.length === 1 && isAny(c[0])) {
                this.set = [c];
                break;
              }
            }
          }
        }
        this.formatted = void 0;
      }
      get range() {
        if (this.formatted === void 0) {
          this.formatted = "";
          for (let i = 0; i < this.set.length; i++) {
            if (i > 0) {
              this.formatted += "||";
            }
            const comps = this.set[i];
            for (let k = 0; k < comps.length; k++) {
              if (k > 0) {
                this.formatted += " ";
              }
              this.formatted += comps[k].toString().trim();
            }
          }
        }
        return this.formatted;
      }
      format() {
        return this.range;
      }
      toString() {
        return this.range;
      }
      parseRange(range) {
        range = range.replace(BUILDSTRIPRE, "");
        const memoOpts = (this.options.includePrerelease && FLAG_INCLUDE_PRERELEASE) | (this.options.loose && FLAG_LOOSE);
        const memoKey = memoOpts + ":" + range;
        const cached = cache.get(memoKey);
        if (cached) {
          return cached;
        }
        const loose = this.options.loose;
        const hr = loose ? re[t.HYPHENRANGELOOSE] : re[t.HYPHENRANGE];
        range = range.replace(hr, hyphenReplace(this.options.includePrerelease));
        debug("hyphen replace", range);
        range = range.replace(re[t.COMPARATORTRIM], comparatorTrimReplace);
        debug("comparator trim", range);
        range = range.replace(re[t.TILDETRIM], tildeTrimReplace);
        debug("tilde trim", range);
        range = range.replace(re[t.CARETTRIM], caretTrimReplace);
        debug("caret trim", range);
        let rangeList = range.split(" ").map((comp) => parseComparator(comp, this.options)).join(" ").split(/\s+/).map((comp) => replaceGTE0(comp, this.options));
        if (loose) {
          rangeList = rangeList.filter((comp) => {
            debug("loose invalid filter", comp, this.options);
            return !!comp.match(re[t.COMPARATORLOOSE]);
          });
        }
        debug("range list", rangeList);
        const rangeMap = /* @__PURE__ */ new Map();
        const comparators = rangeList.map((comp) => new Comparator(comp, this.options));
        for (const comp of comparators) {
          if (isNullSet(comp)) {
            return [comp];
          }
          rangeMap.set(comp.value, comp);
        }
        if (rangeMap.size > 1 && rangeMap.has("")) {
          rangeMap.delete("");
        }
        const result = [...rangeMap.values()];
        cache.set(memoKey, result);
        return result;
      }
      intersects(range, options) {
        if (!(range instanceof _Range)) {
          throw new TypeError("a Range is required");
        }
        return this.set.some((thisComparators) => {
          return isSatisfiable(thisComparators, options) && range.set.some((rangeComparators) => {
            return isSatisfiable(rangeComparators, options) && thisComparators.every((thisComparator) => {
              return rangeComparators.every((rangeComparator) => {
                return thisComparator.intersects(rangeComparator, options);
              });
            });
          });
        });
      }
      // if ANY of the sets match ALL of its comparators, then pass
      test(version) {
        if (!version) {
          return false;
        }
        if (typeof version === "string") {
          try {
            version = new SemVer(version, this.options);
          } catch (er) {
            return false;
          }
        }
        for (let i = 0; i < this.set.length; i++) {
          if (testSet(this.set[i], version, this.options)) {
            return true;
          }
        }
        return false;
      }
    };
    module.exports = Range;
    var LRU = require_lrucache();
    var cache = new LRU();
    var parseOptions = require_parse_options();
    var Comparator = require_comparator();
    var debug = require_debug();
    var SemVer = require_semver();
    var {
      safeRe: re,
      src,
      t,
      comparatorTrimReplace,
      tildeTrimReplace,
      caretTrimReplace
    } = require_re();
    var { FLAG_INCLUDE_PRERELEASE, FLAG_LOOSE } = require_constants();
    var BUILDSTRIPRE = new RegExp(src[t.BUILD], "g");
    var isNullSet = (c) => c.value === "<0.0.0-0";
    var isAny = (c) => c.value === "";
    var isSatisfiable = (comparators, options) => {
      let result = true;
      const remainingComparators = comparators.slice();
      let testComparator = remainingComparators.pop();
      while (result && remainingComparators.length) {
        result = remainingComparators.every((otherComparator) => {
          return testComparator.intersects(otherComparator, options);
        });
        testComparator = remainingComparators.pop();
      }
      return result;
    };
    var parseComparator = (comp, options) => {
      comp = comp.replace(re[t.BUILD], "");
      debug("comp", comp, options);
      comp = replaceCarets(comp, options);
      debug("caret", comp);
      comp = replaceTildes(comp, options);
      debug("tildes", comp);
      comp = replaceXRanges(comp, options);
      debug("xrange", comp);
      comp = replaceStars(comp, options);
      debug("stars", comp);
      return comp;
    };
    var isX = (id2) => !id2 || id2.toLowerCase() === "x" || id2 === "*";
    var invalidXRangeOrder = (M, m, p) => isX(M) && !isX(m) || isX(m) && p && !isX(p);
    var replaceTildes = (comp, options) => {
      return comp.trim().split(/\s+/).map((c) => replaceTilde(c, options)).join(" ");
    };
    var replaceTilde = (comp, options) => {
      const r = options.loose ? re[t.TILDELOOSE] : re[t.TILDE];
      const z = options.includePrerelease ? "-0" : "";
      return comp.replace(r, (_, M, m, p, pr) => {
        debug("tilde", comp, _, M, m, p, pr);
        let ret;
        if (isX(M)) {
          ret = "";
        } else if (isX(m)) {
          ret = `>=${M}.0.0${z} <${+M + 1}.0.0-0`;
        } else if (isX(p)) {
          ret = `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`;
        } else if (pr) {
          debug("replaceTilde pr", pr);
          ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
        } else {
          ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
        }
        debug("tilde return", ret);
        return ret;
      });
    };
    var replaceCarets = (comp, options) => {
      return comp.trim().split(/\s+/).map((c) => replaceCaret(c, options)).join(" ");
    };
    var replaceCaret = (comp, options) => {
      debug("caret", comp, options);
      const r = options.loose ? re[t.CARETLOOSE] : re[t.CARET];
      const z = options.includePrerelease ? "-0" : "";
      return comp.replace(r, (_, M, m, p, pr) => {
        debug("caret", comp, _, M, m, p, pr);
        let ret;
        if (isX(M)) {
          ret = "";
        } else if (isX(m)) {
          ret = `>=${M}.0.0${z} <${+M + 1}.0.0-0`;
        } else if (isX(p)) {
          if (M === "0") {
            ret = `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`;
          } else {
            ret = `>=${M}.${m}.0${z} <${+M + 1}.0.0-0`;
          }
        } else if (pr) {
          debug("replaceCaret pr", pr);
          if (M === "0") {
            if (m === "0") {
              ret = `>=${M}.${m}.${p}-${pr} <${M}.${m}.${+p + 1}-0`;
            } else {
              ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
            }
          } else {
            ret = `>=${M}.${m}.${p}-${pr} <${+M + 1}.0.0-0`;
          }
        } else {
          debug("no pr");
          if (M === "0") {
            if (m === "0") {
              ret = `>=${M}.${m}.${p} <${M}.${m}.${+p + 1}-0`;
            } else {
              ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
            }
          } else {
            ret = `>=${M}.${m}.${p} <${+M + 1}.0.0-0`;
          }
        }
        debug("caret return", ret);
        return ret;
      });
    };
    var replaceXRanges = (comp, options) => {
      debug("replaceXRanges", comp, options);
      return comp.split(/\s+/).map((c) => replaceXRange(c, options)).join(" ");
    };
    var replaceXRange = (comp, options) => {
      comp = comp.trim();
      const r = options.loose ? re[t.XRANGELOOSE] : re[t.XRANGE];
      return comp.replace(r, (ret, gtlt, M, m, p, pr) => {
        debug("xRange", comp, ret, gtlt, M, m, p, pr);
        if (invalidXRangeOrder(M, m, p)) {
          return comp;
        }
        const xM = isX(M);
        const xm = xM || isX(m);
        const xp = xm || isX(p);
        const anyX = xp;
        if (gtlt === "=" && anyX) {
          gtlt = "";
        }
        pr = options.includePrerelease ? "-0" : "";
        if (xM) {
          if (gtlt === ">" || gtlt === "<") {
            ret = "<0.0.0-0";
          } else {
            ret = "*";
          }
        } else if (gtlt && anyX) {
          if (xm) {
            m = 0;
          }
          p = 0;
          if (gtlt === ">") {
            gtlt = ">=";
            if (xm) {
              M = +M + 1;
              m = 0;
              p = 0;
            } else {
              m = +m + 1;
              p = 0;
            }
          } else if (gtlt === "<=") {
            gtlt = "<";
            if (xm) {
              M = +M + 1;
            } else {
              m = +m + 1;
            }
          }
          if (gtlt === "<") {
            pr = "-0";
          }
          ret = `${gtlt + M}.${m}.${p}${pr}`;
        } else if (xm) {
          ret = `>=${M}.0.0${pr} <${+M + 1}.0.0-0`;
        } else if (xp) {
          ret = `>=${M}.${m}.0${pr} <${M}.${+m + 1}.0-0`;
        }
        debug("xRange return", ret);
        return ret;
      });
    };
    var replaceStars = (comp, options) => {
      debug("replaceStars", comp, options);
      return comp.trim().replace(re[t.STAR], "");
    };
    var replaceGTE0 = (comp, options) => {
      debug("replaceGTE0", comp, options);
      return comp.trim().replace(re[options.includePrerelease ? t.GTE0PRE : t.GTE0], "");
    };
    var hyphenReplace = (incPr) => ($0, from, fM, fm, fp, fpr, fb, to, tM, tm, tp, tpr) => {
      if (isX(fM)) {
        from = "";
      } else if (isX(fm)) {
        from = `>=${fM}.0.0${incPr ? "-0" : ""}`;
      } else if (isX(fp)) {
        from = `>=${fM}.${fm}.0${incPr ? "-0" : ""}`;
      } else if (fpr) {
        from = `>=${from}`;
      } else {
        from = `>=${from}${incPr ? "-0" : ""}`;
      }
      if (isX(tM)) {
        to = "";
      } else if (isX(tm)) {
        to = `<${+tM + 1}.0.0-0`;
      } else if (isX(tp)) {
        to = `<${tM}.${+tm + 1}.0-0`;
      } else if (tpr) {
        to = `<=${tM}.${tm}.${tp}-${tpr}`;
      } else if (incPr) {
        to = `<${tM}.${tm}.${+tp + 1}-0`;
      } else {
        to = `<=${to}`;
      }
      return `${from} ${to}`.trim();
    };
    var testSet = (set, version, options) => {
      for (let i = 0; i < set.length; i++) {
        if (!set[i].test(version)) {
          return false;
        }
      }
      if (version.prerelease.length && !options.includePrerelease) {
        for (let i = 0; i < set.length; i++) {
          debug(set[i].semver);
          if (set[i].semver === Comparator.ANY) {
            continue;
          }
          if (set[i].semver.prerelease.length > 0) {
            const allowed = set[i].semver;
            if (allowed.major === version.major && allowed.minor === version.minor && allowed.patch === version.patch) {
              return true;
            }
          }
        }
        return false;
      }
      return true;
    };
  }
});

// ../builder/node_modules/semver/classes/comparator.js
var require_comparator = __commonJS({
  "../builder/node_modules/semver/classes/comparator.js"(exports, module) {
    "use strict";
    var ANY = /* @__PURE__ */ Symbol("SemVer ANY");
    var Comparator = class _Comparator {
      static get ANY() {
        return ANY;
      }
      constructor(comp, options) {
        options = parseOptions(options);
        if (comp instanceof _Comparator) {
          if (comp.loose === !!options.loose) {
            return comp;
          } else {
            comp = comp.value;
          }
        }
        comp = comp.trim().split(/\s+/).join(" ");
        debug("comparator", comp, options);
        this.options = options;
        this.loose = !!options.loose;
        this.parse(comp);
        if (this.semver === ANY) {
          this.value = "";
        } else {
          this.value = this.operator + this.semver.version;
        }
        debug("comp", this);
      }
      parse(comp) {
        const r = this.options.loose ? re[t.COMPARATORLOOSE] : re[t.COMPARATOR];
        const m = comp.match(r);
        if (!m) {
          throw new TypeError(`Invalid comparator: ${comp}`);
        }
        this.operator = m[1] !== void 0 ? m[1] : "";
        if (this.operator === "=") {
          this.operator = "";
        }
        if (!m[2]) {
          this.semver = ANY;
        } else {
          this.semver = new SemVer(m[2], this.options.loose);
        }
      }
      toString() {
        return this.value;
      }
      test(version) {
        debug("Comparator.test", version, this.options.loose);
        if (this.semver === ANY || version === ANY) {
          return true;
        }
        if (typeof version === "string") {
          try {
            version = new SemVer(version, this.options);
          } catch (er) {
            return false;
          }
        }
        return cmp(version, this.operator, this.semver, this.options);
      }
      intersects(comp, options) {
        if (!(comp instanceof _Comparator)) {
          throw new TypeError("a Comparator is required");
        }
        if (this.operator === "") {
          if (this.value === "") {
            return true;
          }
          return new Range(comp.value, options).test(this.value);
        } else if (comp.operator === "") {
          if (comp.value === "") {
            return true;
          }
          return new Range(this.value, options).test(comp.semver);
        }
        options = parseOptions(options);
        if (options.includePrerelease && (this.value === "<0.0.0-0" || comp.value === "<0.0.0-0")) {
          return false;
        }
        if (!options.includePrerelease && (this.value.startsWith("<0.0.0") || comp.value.startsWith("<0.0.0"))) {
          return false;
        }
        if (this.operator.startsWith(">") && comp.operator.startsWith(">")) {
          return true;
        }
        if (this.operator.startsWith("<") && comp.operator.startsWith("<")) {
          return true;
        }
        if (this.semver.version === comp.semver.version && this.operator.includes("=") && comp.operator.includes("=")) {
          return true;
        }
        if (cmp(this.semver, "<", comp.semver, options) && this.operator.startsWith(">") && comp.operator.startsWith("<")) {
          return true;
        }
        if (cmp(this.semver, ">", comp.semver, options) && this.operator.startsWith("<") && comp.operator.startsWith(">")) {
          return true;
        }
        return false;
      }
    };
    module.exports = Comparator;
    var parseOptions = require_parse_options();
    var { safeRe: re, t } = require_re();
    var cmp = require_cmp();
    var debug = require_debug();
    var SemVer = require_semver();
    var Range = require_range();
  }
});

// ../builder/node_modules/semver/functions/satisfies.js
var require_satisfies = __commonJS({
  "../builder/node_modules/semver/functions/satisfies.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var satisfies = (version, range, options) => {
      try {
        range = new Range(range, options);
      } catch (er) {
        return false;
      }
      return range.test(version);
    };
    module.exports = satisfies;
  }
});

// ../builder/node_modules/semver/ranges/to-comparators.js
var require_to_comparators = __commonJS({
  "../builder/node_modules/semver/ranges/to-comparators.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var toComparators = (range, options) => new Range(range, options).set.map((comp) => comp.map((c) => c.value).join(" ").trim().split(" "));
    module.exports = toComparators;
  }
});

// ../builder/node_modules/semver/ranges/max-satisfying.js
var require_max_satisfying = __commonJS({
  "../builder/node_modules/semver/ranges/max-satisfying.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var maxSatisfying = (versions, range, options) => {
      let max = null;
      let maxSV = null;
      let rangeObj = null;
      try {
        rangeObj = new Range(range, options);
      } catch (er) {
        return null;
      }
      versions.forEach((v) => {
        if (rangeObj.test(v)) {
          if (!max || maxSV.compare(v) === -1) {
            max = v;
            maxSV = new SemVer(max, options);
          }
        }
      });
      return max;
    };
    module.exports = maxSatisfying;
  }
});

// ../builder/node_modules/semver/ranges/min-satisfying.js
var require_min_satisfying = __commonJS({
  "../builder/node_modules/semver/ranges/min-satisfying.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var minSatisfying = (versions, range, options) => {
      let min = null;
      let minSV = null;
      let rangeObj = null;
      try {
        rangeObj = new Range(range, options);
      } catch (er) {
        return null;
      }
      versions.forEach((v) => {
        if (rangeObj.test(v)) {
          if (!min || minSV.compare(v) === 1) {
            min = v;
            minSV = new SemVer(min, options);
          }
        }
      });
      return min;
    };
    module.exports = minSatisfying;
  }
});

// ../builder/node_modules/semver/ranges/min-version.js
var require_min_version = __commonJS({
  "../builder/node_modules/semver/ranges/min-version.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var Range = require_range();
    var gt = require_gt();
    var minVersion = (range, loose) => {
      range = new Range(range, loose);
      let minver = new SemVer("0.0.0");
      if (range.test(minver)) {
        return minver;
      }
      minver = new SemVer("0.0.0-0");
      if (range.test(minver)) {
        return minver;
      }
      minver = null;
      for (let i = 0; i < range.set.length; ++i) {
        const comparators = range.set[i];
        let setMin = null;
        comparators.forEach((comparator) => {
          const compver = new SemVer(comparator.semver.version);
          switch (comparator.operator) {
            case ">":
              if (compver.prerelease.length === 0) {
                compver.patch++;
              } else {
                compver.prerelease.push(0);
              }
              compver.raw = compver.format();
            /* fallthrough */
            case "":
            case ">=":
              if (!setMin || gt(compver, setMin)) {
                setMin = compver;
              }
              break;
            case "<":
            case "<=":
              break;
            /* istanbul ignore next */
            default:
              throw new Error(`Unexpected operation: ${comparator.operator}`);
          }
        });
        if (setMin && (!minver || gt(minver, setMin))) {
          minver = setMin;
        }
      }
      if (minver && range.test(minver)) {
        return minver;
      }
      return null;
    };
    module.exports = minVersion;
  }
});

// ../builder/node_modules/semver/ranges/valid.js
var require_valid2 = __commonJS({
  "../builder/node_modules/semver/ranges/valid.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var validRange = (range, options) => {
      try {
        return new Range(range, options).range || "*";
      } catch (er) {
        return null;
      }
    };
    module.exports = validRange;
  }
});

// ../builder/node_modules/semver/ranges/outside.js
var require_outside = __commonJS({
  "../builder/node_modules/semver/ranges/outside.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var Comparator = require_comparator();
    var { ANY } = Comparator;
    var Range = require_range();
    var satisfies = require_satisfies();
    var gt = require_gt();
    var lt = require_lt();
    var lte = require_lte();
    var gte = require_gte();
    var outside = (version, range, hilo, options) => {
      version = new SemVer(version, options);
      range = new Range(range, options);
      let gtfn, ltefn, ltfn, comp, ecomp;
      switch (hilo) {
        case ">":
          gtfn = gt;
          ltefn = lte;
          ltfn = lt;
          comp = ">";
          ecomp = ">=";
          break;
        case "<":
          gtfn = lt;
          ltefn = gte;
          ltfn = gt;
          comp = "<";
          ecomp = "<=";
          break;
        default:
          throw new TypeError('Must provide a hilo val of "<" or ">"');
      }
      if (satisfies(version, range, options)) {
        return false;
      }
      for (let i = 0; i < range.set.length; ++i) {
        const comparators = range.set[i];
        let high = null;
        let low = null;
        comparators.forEach((comparator) => {
          if (comparator.semver === ANY) {
            comparator = new Comparator(">=0.0.0");
          }
          high = high || comparator;
          low = low || comparator;
          if (gtfn(comparator.semver, high.semver, options)) {
            high = comparator;
          } else if (ltfn(comparator.semver, low.semver, options)) {
            low = comparator;
          }
        });
        if (high.operator === comp || high.operator === ecomp) {
          return false;
        }
        if ((!low.operator || low.operator === comp) && ltefn(version, low.semver)) {
          return false;
        } else if (low.operator === ecomp && ltfn(version, low.semver)) {
          return false;
        }
      }
      return true;
    };
    module.exports = outside;
  }
});

// ../builder/node_modules/semver/ranges/gtr.js
var require_gtr = __commonJS({
  "../builder/node_modules/semver/ranges/gtr.js"(exports, module) {
    "use strict";
    var outside = require_outside();
    var gtr = (version, range, options) => outside(version, range, ">", options);
    module.exports = gtr;
  }
});

// ../builder/node_modules/semver/ranges/ltr.js
var require_ltr = __commonJS({
  "../builder/node_modules/semver/ranges/ltr.js"(exports, module) {
    "use strict";
    var outside = require_outside();
    var ltr = (version, range, options) => outside(version, range, "<", options);
    module.exports = ltr;
  }
});

// ../builder/node_modules/semver/ranges/intersects.js
var require_intersects = __commonJS({
  "../builder/node_modules/semver/ranges/intersects.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var intersects = (r1, r2, options) => {
      r1 = new Range(r1, options);
      r2 = new Range(r2, options);
      return r1.intersects(r2, options);
    };
    module.exports = intersects;
  }
});

// ../builder/node_modules/semver/ranges/simplify.js
var require_simplify = __commonJS({
  "../builder/node_modules/semver/ranges/simplify.js"(exports, module) {
    "use strict";
    var satisfies = require_satisfies();
    var compare = require_compare();
    module.exports = (versions, range, options) => {
      const set = [];
      let first = null;
      let prev = null;
      const v = versions.sort((a, b) => compare(a, b, options));
      for (const version of v) {
        const included = satisfies(version, range, options);
        if (included) {
          prev = version;
          if (!first) {
            first = version;
          }
        } else {
          if (prev) {
            set.push([first, prev]);
          }
          prev = null;
          first = null;
        }
      }
      if (first) {
        set.push([first, null]);
      }
      const ranges = [];
      for (const [min, max] of set) {
        if (min === max) {
          ranges.push(min);
        } else if (!max && min === v[0]) {
          ranges.push("*");
        } else if (!max) {
          ranges.push(`>=${min}`);
        } else if (min === v[0]) {
          ranges.push(`<=${max}`);
        } else {
          ranges.push(`${min} - ${max}`);
        }
      }
      const simplified = ranges.join(" || ");
      const original = typeof range.raw === "string" ? range.raw : String(range);
      return simplified.length < original.length ? simplified : range;
    };
  }
});

// ../builder/node_modules/semver/ranges/subset.js
var require_subset = __commonJS({
  "../builder/node_modules/semver/ranges/subset.js"(exports, module) {
    "use strict";
    var Range = require_range();
    var Comparator = require_comparator();
    var { ANY } = Comparator;
    var satisfies = require_satisfies();
    var compare = require_compare();
    var subset = (sub, dom, options = {}) => {
      if (sub === dom) {
        return true;
      }
      sub = new Range(sub, options);
      dom = new Range(dom, options);
      let sawNonNull = false;
      OUTER: for (const simpleSub of sub.set) {
        for (const simpleDom of dom.set) {
          const isSub = simpleSubset(simpleSub, simpleDom, options);
          sawNonNull = sawNonNull || isSub !== null;
          if (isSub) {
            continue OUTER;
          }
        }
        if (sawNonNull) {
          return false;
        }
      }
      return true;
    };
    var minimumVersionWithPreRelease = [new Comparator(">=0.0.0-0")];
    var minimumVersion = [new Comparator(">=0.0.0")];
    var simpleSubset = (sub, dom, options) => {
      if (sub === dom) {
        return true;
      }
      if (sub.length === 1 && sub[0].semver === ANY) {
        if (dom.length === 1 && dom[0].semver === ANY) {
          return true;
        } else if (options.includePrerelease) {
          sub = minimumVersionWithPreRelease;
        } else {
          sub = minimumVersion;
        }
      }
      if (dom.length === 1 && dom[0].semver === ANY) {
        if (options.includePrerelease) {
          return true;
        } else {
          dom = minimumVersion;
        }
      }
      const eqSet = /* @__PURE__ */ new Set();
      let gt, lt;
      for (const c of sub) {
        if (c.operator === ">" || c.operator === ">=") {
          gt = higherGT(gt, c, options);
        } else if (c.operator === "<" || c.operator === "<=") {
          lt = lowerLT(lt, c, options);
        } else {
          eqSet.add(c.semver);
        }
      }
      if (eqSet.size > 1) {
        return null;
      }
      let gtltComp;
      if (gt && lt) {
        gtltComp = compare(gt.semver, lt.semver, options);
        if (gtltComp > 0) {
          return null;
        } else if (gtltComp === 0 && (gt.operator !== ">=" || lt.operator !== "<=")) {
          return null;
        }
      }
      for (const eq of eqSet) {
        if (gt && !satisfies(eq, String(gt), options)) {
          return null;
        }
        if (lt && !satisfies(eq, String(lt), options)) {
          return null;
        }
        for (const c of dom) {
          if (!satisfies(eq, String(c), options)) {
            return false;
          }
        }
        return true;
      }
      let higher, lower;
      let hasDomLT, hasDomGT;
      let needDomLTPre = lt && !options.includePrerelease && lt.semver.prerelease.length ? lt.semver : false;
      let needDomGTPre = gt && !options.includePrerelease && gt.semver.prerelease.length ? gt.semver : false;
      if (needDomLTPre && needDomLTPre.prerelease.length === 1 && lt.operator === "<" && needDomLTPre.prerelease[0] === 0) {
        needDomLTPre = false;
      }
      for (const c of dom) {
        hasDomGT = hasDomGT || c.operator === ">" || c.operator === ">=";
        hasDomLT = hasDomLT || c.operator === "<" || c.operator === "<=";
        if (gt) {
          if (needDomGTPre) {
            if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomGTPre.major && c.semver.minor === needDomGTPre.minor && c.semver.patch === needDomGTPre.patch) {
              needDomGTPre = false;
            }
          }
          if (c.operator === ">" || c.operator === ">=") {
            higher = higherGT(gt, c, options);
            if (higher === c && higher !== gt) {
              return false;
            }
          } else if (gt.operator === ">=" && !c.test(gt.semver)) {
            return false;
          }
        }
        if (lt) {
          if (needDomLTPre) {
            if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomLTPre.major && c.semver.minor === needDomLTPre.minor && c.semver.patch === needDomLTPre.patch) {
              needDomLTPre = false;
            }
          }
          if (c.operator === "<" || c.operator === "<=") {
            lower = lowerLT(lt, c, options);
            if (lower === c && lower !== lt) {
              return false;
            }
          } else if (lt.operator === "<=" && !c.test(lt.semver)) {
            return false;
          }
        }
        if (!c.operator && (lt || gt) && gtltComp !== 0) {
          return false;
        }
      }
      if (gt && hasDomLT && !lt && gtltComp !== 0) {
        return false;
      }
      if (lt && hasDomGT && !gt && gtltComp !== 0) {
        return false;
      }
      if (needDomGTPre || needDomLTPre) {
        return false;
      }
      return true;
    };
    var higherGT = (a, b, options) => {
      if (!a) {
        return b;
      }
      const comp = compare(a.semver, b.semver, options);
      return comp > 0 ? a : comp < 0 ? b : b.operator === ">" && a.operator === ">=" ? b : a;
    };
    var lowerLT = (a, b, options) => {
      if (!a) {
        return b;
      }
      const comp = compare(a.semver, b.semver, options);
      return comp < 0 ? a : comp > 0 ? b : b.operator === "<" && a.operator === "<=" ? b : a;
    };
    module.exports = subset;
  }
});

// ../builder/node_modules/semver/index.js
var require_semver2 = __commonJS({
  "../builder/node_modules/semver/index.js"(exports, module) {
    "use strict";
    var internalRe = require_re();
    var constants = require_constants();
    var SemVer = require_semver();
    var identifiers = require_identifiers();
    var parse = require_parse();
    var valid = require_valid();
    var clean = require_clean();
    var inc = require_inc();
    var diff = require_diff();
    var major = require_major();
    var minor = require_minor();
    var patch = require_patch();
    var prerelease = require_prerelease();
    var compare = require_compare();
    var rcompare = require_rcompare();
    var compareLoose = require_compare_loose();
    var compareBuild = require_compare_build();
    var sort = require_sort();
    var rsort = require_rsort();
    var gt = require_gt();
    var lt = require_lt();
    var eq = require_eq();
    var neq = require_neq();
    var gte = require_gte();
    var lte = require_lte();
    var cmp = require_cmp();
    var coerce = require_coerce();
    var truncate = require_truncate();
    var Comparator = require_comparator();
    var Range = require_range();
    var satisfies = require_satisfies();
    var toComparators = require_to_comparators();
    var maxSatisfying = require_max_satisfying();
    var minSatisfying = require_min_satisfying();
    var minVersion = require_min_version();
    var validRange = require_valid2();
    var outside = require_outside();
    var gtr = require_gtr();
    var ltr = require_ltr();
    var intersects = require_intersects();
    var simplifyRange = require_simplify();
    var subset = require_subset();
    module.exports = {
      parse,
      valid,
      clean,
      inc,
      diff,
      major,
      minor,
      patch,
      prerelease,
      compare,
      rcompare,
      compareLoose,
      compareBuild,
      sort,
      rsort,
      gt,
      lt,
      eq,
      neq,
      gte,
      lte,
      cmp,
      coerce,
      truncate,
      Comparator,
      Range,
      satisfies,
      toComparators,
      maxSatisfying,
      minSatisfying,
      minVersion,
      validRange,
      outside,
      gtr,
      ltr,
      intersects,
      simplifyRange,
      subset,
      SemVer,
      re: internalRe.re,
      src: internalRe.src,
      tokens: internalRe.t,
      SEMVER_SPEC_VERSION: constants.SEMVER_SPEC_VERSION,
      RELEASE_TYPES: constants.RELEASE_TYPES,
      compareIdentifiers: identifiers.compareIdentifiers,
      rcompareIdentifiers: identifiers.rcompareIdentifiers
    };
  }
});

// ../builder/integration/team-client/starlink/drive.cjs
var require_drive = __commonJS({
  "../builder/integration/team-client/starlink/drive.cjs"(exports, module) {
    "use strict";
    var { createHash: createHash2, randomUUID: randomUUID4 } = __require("node:crypto");
    var PREFIX = "/api/personal-space";
    var CHUNK_SIZE = 4 * 1024 * 1024;
    var fail5 = (code) => Object.assign(new Error(code), { code });
    var digest = (bytes) => createHash2("sha256").update(bytes).digest("hex");
    var id2 = (value) => {
      if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw fail5("SPACE_INVALID_ID");
      return value;
    };
    var folder = (value) => value === "" ? "" : id2(value);
    function createDriveClient(host) {
      let initialized;
      async function request(route, options = {}) {
        options.signal?.throwIfAborted();
        await (initialized ||= host.context().catch((error) => {
          initialized = null;
          throw error;
        }));
        return host.request(PREFIX + route, { timeoutMs: route.endsWith("/complete") ? 12e4 : 6e4, ...options });
      }
      async function json(route, options = {}) {
        const response = await request(route, options);
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw fail5(body?.detail?.code || body?.error?.code || (response.status === 404 && route === "/overview" ? "SPACE_UPGRADE_REQUIRED" : "SPACE_REQUEST_FAILED"));
        }
        return response.status === 204 ? void 0 : response.json();
      }
      const uploadStatus = (uploadId, { signal } = {}) => json(`/uploads/${id2(uploadId)}`, { signal });
      const createUpload = ({ uploadId, name, size, parent = "", signal }) => json("/uploads", {
        method: "POST",
        body: { id: id2(uploadId), parent: folder(parent), name, size },
        signal
      });
      const writeChunk = (uploadId, { offset, data, signal }) => {
        if (!(data instanceof Uint8Array) || !data.length || data.length > CHUNK_SIZE) throw fail5("SPACE_CHUNK_INVALID");
        return json(`/uploads/${id2(uploadId)}?offset=${offset}`, {
          method: "PUT",
          body: data,
          signal,
          headers: { "content-type": "application/octet-stream", "x-content-sha256": digest(data) }
        });
      };
      const completeUpload = (uploadId, { digest: checksum, signal }) => json(`/uploads/${id2(uploadId)}/complete`, {
        method: "POST",
        body: { digest: checksum },
        signal
      });
      const stat2 = (itemId, { signal } = {}) => json(`/files/${id2(itemId)}`, { signal });
      async function upload({ name, parent = "", data, size, uploadId = randomUUID4().replaceAll("-", ""), signal, onProgress } = {}) {
        if (typeof data === "string") data = Buffer.from(data, "utf8");
        const fixed = data instanceof Uint8Array;
        if (fixed) size ??= data.byteLength;
        if (!Number.isSafeInteger(size) || size < 0 || !fixed && !data?.[Symbol.asyncIterator]) throw fail5("SPACE_INVALID_SIZE");
        if (fixed && size !== data.byteLength) throw fail5("SPACE_INVALID_SIZE");
        try {
          const remote = await createUpload({ uploadId, name, size, parent, signal });
          if (!Number.isSafeInteger(remote.offset) || remote.offset < 0 || remote.offset > size) throw fail5("SPACE_CHUNK_INVALID");
          let seen = 0, offset = remote.offset, filled = 0;
          const checksum = createHash2("sha256"), buffer = Buffer.alloc(CHUNK_SIZE);
          const append = async () => {
            const result = await writeChunk(uploadId, { offset, data: buffer.subarray(0, filled), signal });
            if (result.offset !== offset + filled) throw fail5("SPACE_CHUNK_INVALID");
            offset = result.offset;
            filled = 0;
            onProgress?.({ uploadId, offset, size });
          };
          onProgress?.({ uploadId, offset, size });
          for await (const part of fixed ? [data] : data) {
            signal?.throwIfAborted();
            if (!(part instanceof Uint8Array)) throw fail5("SPACE_CHUNK_INVALID");
            const bytes = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
            if (seen + bytes.length > size) throw fail5("SPACE_INVALID_SIZE");
            checksum.update(bytes);
            let cursor = Math.min(bytes.length, Math.max(0, remote.offset - seen));
            seen += bytes.length;
            while (cursor < bytes.length) {
              const count = Math.min(CHUNK_SIZE - filled, bytes.length - cursor);
              bytes.copy(buffer, filled, cursor, cursor + count);
              filled += count;
              cursor += count;
              if (filled === CHUNK_SIZE) await append();
            }
          }
          if (seen !== size) throw fail5("SPACE_INVALID_SIZE");
          if (filled) await append();
          const expected = checksum.digest("hex");
          const entry = await completeUpload(uploadId, { digest: expected, signal });
          if (entry.digest !== expected || entry.size !== size) throw fail5("SPACE_LOCAL_FILE_CHANGED");
          return entry;
        } catch (error) {
          if (error && typeof error === "object") error.uploadId = uploadId;
          throw error;
        }
      }
      async function* read(itemId, { signal } = {}) {
        const entry = await stat2(itemId, { signal });
        if (entry.kind !== "file") throw fail5("SPACE_NOT_FILE");
        const checksum = createHash2("sha256");
        for (let offset = 0; offset < entry.size; ) {
          const response = await request(`/files/${id2(itemId)}/content?offset=${offset}&length=${CHUNK_SIZE}`, { signal });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw fail5(body?.detail?.code || "SPACE_REQUEST_FAILED");
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.length || bytes.length > Math.min(CHUNK_SIZE, entry.size - offset) || digest(bytes) !== response.headers.get("x-content-sha256")) throw fail5("SPACE_CHUNK_INVALID");
          const etag = response.headers.get("etag");
          if (etag !== entry.digest && etag !== `"${entry.digest}"`) throw fail5("SPACE_REMOTE_FILE_CHANGED");
          checksum.update(bytes);
          offset += bytes.length;
          yield bytes;
        }
        if (checksum.digest("hex") !== entry.digest) throw fail5("SPACE_CHUNK_INVALID");
      }
      return Object.freeze({
        overview: ({ signal } = {}) => json("/overview", { signal }),
        list: ({ parent = "", trash = false, signal } = {}) => json(`/files?parent=${folder(parent)}&trash=${trash === true}`, { signal }),
        stat: stat2,
        mkdir: ({ name, parent = "", signal }) => json("/folders", { method: "POST", body: { parent: folder(parent), name }, signal }),
        move: ({ id: itemId, name, parent = "", signal }) => json(`/files/${id2(itemId)}`, { method: "PATCH", body: { parent: folder(parent), name }, signal }),
        trash: (itemId, { signal } = {}) => json(`/files/${id2(itemId)}`, { method: "DELETE", signal }),
        restore: (itemId, { signal } = {}) => json(`/trash/${id2(itemId)}/restore`, { method: "POST", signal }),
        purge: (itemId, { signal } = {}) => json(`/trash/${id2(itemId)}`, { method: "DELETE", signal }),
        createUpload,
        uploadStatus,
        writeChunk,
        completeUpload,
        cancelUpload: (uploadId, { signal } = {}) => json(`/uploads/${id2(uploadId)}`, { method: "DELETE", signal }),
        upload,
        read
      });
    }
    module.exports = { createDriveClient };
  }
});

// ../builder/integration/team-client/starlink/correction.mjs
function validatedDeletion(input) {
  const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
  if (!input || Object.keys(input).some((k) => !["warehouseId", "id", "versionId", "operationId", "confirmed"].includes(k)) || !["warehouseId", "id", "operationId"].every((k) => uuid(input[k])) || input.versionId !== null && !uuid(input.versionId) || input.confirmed !== true) throw Object.assign(Error("TEAM_DATA_TARGET_INVALID"), { code: "TEAM_DATA_TARGET_INVALID" });
  return input;
}
function validatedCorrection(input) {
  const fail5 = () => {
    throw Object.assign(Error("TEAM_DATA_TARGET_INVALID"), { code: "TEAM_DATA_TARGET_INVALID" });
  };
  const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
  if (!input || Array.isArray(input) || Object.keys(input).some((k) => !["warehouseId", "id", "versionId", "operationId", "segments"].includes(k)) || !["warehouseId", "id", "versionId", "operationId"].every((k) => uuid(input[k])) || !Array.isArray(input.segments) || !input.segments.length || input.segments.length > 2e3) fail5();
  const ids = /* @__PURE__ */ new Set();
  let bytes = 0;
  for (const segment of input.segments) {
    if (!segment || Object.keys(segment).some((k) => !["id", "text"].includes(k)) || !uuid(segment.id) || ids.has(segment.id) || typeof segment.text !== "string" || segment.text.includes("\0")) fail5();
    ids.add(segment.id);
    bytes += new TextEncoder().encode(segment.text).length;
    if (bytes > 768 * 1024) fail5();
  }
  return { ...input, segments: input.segments.map((s) => ({ id: s.id, text: s.text })) };
}

// ../builder/integration/team-client/starlink/warehouse-rename.mjs
var UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
var fail = (code) => Object.assign(Error(code), { code });
function validatedWarehouseRename(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["warehouseId", "name", "operationId"].includes(key)) || typeof input.warehouseId !== "string" || !UUID.test(input.warehouseId) || typeof input.operationId !== "string" || !UUID.test(input.operationId)) throw fail("TEAM_DATA_TARGET_INVALID");
  if (typeof input.name !== "string") throw fail("WAREHOUSE_INVALID_NAME");
  const name = input.name.trim();
  if (!name || [...name].length > 60 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) throw fail("WAREHOUSE_INVALID_NAME");
  return { warehouseId: input.warehouseId, name, operationId: input.operationId };
}

// ../builder/integration/bundled-starlink-version.mjs
var import_semver = __toESM(require_semver2(), 1);
import { readFile } from "node:fs/promises";
import path from "node:path";
async function needsBundledStarlink(installed, packageDir, applications) {
  if (!installed) return true;
  if (!packageDir || installed.selectionRequired || installed.envelope || installed.artifactId || !import_semver.default.valid(installed.version)) return false;
  if (import_semver.default.valid(installed.previous?.version) && import_semver.default.gt(installed.previous.version, installed.version)) return false;
  const manifest = JSON.parse(await readFile(path.join(packageDir, "application.manifest.json"), "utf8"));
  if (!import_semver.default.valid(manifest.version)) throw Object.assign(Error("TEAM_STARLINK_PACKAGE_INVALID"), { code: "TEAM_STARLINK_PACKAGE_INVALID" });
  if (!import_semver.default.gt(manifest.version, installed.version)) return false;
  return !applications.activate?.("centaurai.wanx.semantica");
}

// ../builder/integration/team-client/assistant-team-data-addon.mjs
function assistantAwareTeamDataService(createOriginal, options) {
  const service = createOriginal(options);
  return { ...service, async action(action, input = {}) {
    if (!["assistant-access", "assistant-access-update"].includes(action)) return service.action(action, input);
    const wid = input.warehouseId;
    if (typeof wid !== "string" || !/^[a-f0-9-]{36}$/.test(wid)) throw Object.assign(Error("TEAM_DATA_TARGET_INVALID"), { code: "TEAM_DATA_TARGET_INVALID" });
    const link = await service.connection();
    const response = await link.request({
      path: "/api/assistant/knowledge/access/" + wid,
      method: action === "assistant-access" ? "GET" : "PUT",
      ...action === "assistant-access-update" ? { headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ audience: input.audience, members: input.members, revision: input.revision })) } : {}
    });
    link.context();
    let value;
    try {
      value = JSON.parse(response.body.toString());
    } catch {
      throw Error("TEAM_DATA_RESPONSE_INVALID");
    }
    if (response.status < 200 || response.status >= 300) {
      const code = value.detail?.code || value.error?.code || "TEAM_DATA_ACTION_DENIED";
      throw Object.assign(Error(code), { code });
    }
    return value;
  } };
}

// ../builder/integration/team-client/data-service.mjs
import { randomUUID as randomUUID3 } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile as readFile3, writeFile as writeFile2, rm as rm2 } from "node:fs/promises";
import path3 from "node:path";
import os from "node:os";

// ../builder/integration/team-client/starlink/service.mjs
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, rename, rm, open, readFile as readFile2, writeFile } from "node:fs/promises";
import path2 from "node:path";

// ../builder/integration/team-client/starlink/material-contract.mjs
var id = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function materialDiagnostic(error = {}, defaults = {}) {
  const status = error.httpStatus ?? defaults.httpStatus;
  const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || "") ? error.code : "MATERIAL_REQUEST_FAILED";
  const category = error.category === "structure" ? "structure" : status === 401 || status === 403 || /AUTH|FORBIDDEN|OWNER_REQUIRED|SESSION/.test(code) ? "authorization" : status === 404 ? "unavailable" : status >= 500 ? "server" : status >= 400 ? "business" : /INVALID_RESPONSE|RESPONSE_INVALID/.test(code) ? "structure" : "network";
  const requestId = error.requestId ?? defaults.requestId;
  return {
    code,
    category,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    requestId: id(requestId) ? requestId : null,
    ...(error.requestSource ?? defaults.requestSource) === "client" ? { requestSource: "client" } : {}
  };
}

// ../builder/integration/team-client/starlink/service.mjs
var fail2 = (code, message) => Object.assign(new Error(message || code), { code, publicMessage: message });
var CHUNK = 1024 * 1024;
var ID = /^[A-Za-z0-9_-]{1,128}$/;
var FORMATS = /* @__PURE__ */ new Set([
  "txt",
  "md",
  "markdown",
  "docx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "wav",
  "mp3",
  "m4a",
  "flac",
  "pptx",
  "xlsx",
  "xls",
  "xlsm"
]);
var resource = (value) => {
  if (typeof value !== "string" || !ID.test(value))
    throw fail2("INVALID_RESOURCE");
  return encodeURIComponent(value);
};
var SemanticaService = class {
  constructor({
    host,
    selectFiles,
    selectArchive,
    selectSkill,
    selectSave,
    emit = () => {
    }
  }) {
    this.host = host;
    this.selectFiles = selectFiles;
    this.selectSave = selectSave;
    this.selectArchive = selectArchive;
    this.selectSkill = selectSkill;
    this.emit = emit;
    this.invalid = false;
    this.warehouseGeneration = 0;
    this.context = null;
    this.files = /* @__PURE__ */ new Map();
    this.controller = new AbortController();
    this.unsubscribe = host?.onSessionInvalidated(() => this.invalidate());
  }
  invalidate() {
    if (this.invalid) return;
    this.invalid = true;
    this.context = null;
    this.files.clear();
    this.controller.abort();
    this.emit({ type: "invalidated", code: "HOST_SESSION_EXPIRED" });
  }
  assertLive() {
    if (this.invalid) throw fail2("HOST_SESSION_EXPIRED");
    if (!this.host) throw fail2("WANX_HOST_REQUIRED");
  }
  async api(endpoint, { method = "GET", body, timeoutMs = 6e4, diagnostic = false } = {}) {
    this.assertLive();
    let response;
    const requestId = diagnostic ? body?._native_operation_id || randomUUID() : void 0;
    try {
      response = await this.host.request("/api/semantica" + endpoint, {
        method,
        body,
        signal: this.controller.signal,
        timeoutMs
      });
    } catch (error) {
      if (this.invalid) throw fail2("HOST_SESSION_EXPIRED");
      const failure = fail2(
        error.code === "NETWORK_NOT_READY" ? "NETWORK_NOT_READY" : "SEMANTICA_CONNECTION_FAILED"
      );
      if (diagnostic) Object.assign(failure, materialDiagnostic({ code: error.code || failure.code }, { requestId, requestSource: "client" }));
      throw failure;
    }
    this.assertLive();
    if (method === "PATCH" && /^\/warehouses\/[a-f0-9-]{36}$/.test(endpoint) && response.status === 405)
      throw fail2("SEMANTICA_UPGRADE_REQUIRED");
    const serverRequestId = response.headers?.get("x-request-id");
    const metadata = { httpStatus: response.status, requestId: serverRequestId || requestId, requestSource: serverRequestId ? "server" : "client" };
    let value;
    try {
      value = await response.json();
    } catch {
      throw Object.assign(fail2(
        response.status === 404 ? "SEMANTICA_UPGRADE_REQUIRED" : "SEMANTICA_INVALID_RESPONSE"
      ), diagnostic ? materialDiagnostic({ code: response.status === 404 ? "SEMANTICA_UPGRADE_REQUIRED" : "SEMANTICA_INVALID_RESPONSE" }, metadata) : {});
    }
    this.assertLive();
    if (diagnostic && !response.ok) {
      const details = materialDiagnostic({ code: value?.code }, metadata);
      throw Object.assign(fail2(details.code), details);
    }
    if (!response.ok)
      throw fail2(
        /^(?:SEMANTICA|WAREHOUSE|MIGRATION|ACCESS_KEY|MODEL|MODELING|SKILL|REASONING)_[A-Z_]+$/.test(
          value.code || ""
        ) ? value.code : response.status === 404 ? "SEMANTICA_UPGRADE_REQUIRED" : "SEMANTICA_REQUEST_FAILED",
        /^(?:WAREHOUSE|MIGRATION|ACCESS_KEY|MODEL|MODELING|SKILL|REASONING)_[A-Z_]+$/.test(value.code || "") && typeof value.message === "string" && value.message.length <= 200 ? value.message : void 0
      );
    return diagnostic ? { value, diagnostics: materialDiagnostic({ code: "MATERIAL_RESPONSE_RECEIVED" }, metadata) } : value;
  }
  async initialize() {
    this.assertLive();
    try {
      this.context = await this.host.context();
    } catch {
      throw fail2("HOST_SESSION_EXPIRED");
    }
    this.assertLive();
    const [status, capabilities, warehouses, runtime] = await Promise.all([
      this.api("/status"),
      this.api("/capabilities"),
      this.api("/warehouses"),
      this.api("/warehouses/runtime")
    ]);
    this.capabilities = capabilities;
    return {
      identity: {
        boxId: this.context.boxId,
        boxName: this.context.boxName || this.context.deviceName || this.context.boxId,
        user: {
          id: this.context.user.id,
          name: this.context.user.display_name || this.context.user.username || "\u4E07\u8C61\u7528\u6237"
        },
        connection: this.context.connection
      },
      status,
      capabilities,
      retrieval: null,
      warehouses,
      runtime
    };
  }
  async choose(warehouseId, migration = false) {
    this.assertLive();
    const selected = migration ? await this.selectArchive() : await this.selectFiles();
    this.assertLive();
    const result = [];
    for (const filePath of selected) {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      const name = path2.basename(filePath), format = path2.extname(name).slice(1).toLowerCase();
      const accepted = this.capabilities?.accepted_suffixes?.map(
        (x) => x.replace(/^\./, "")
      ) || [...FORMATS];
      if (migration ? !["xingtu", "zip"].includes(format) : !accepted.includes(format))
        throw fail2("SEMANTICA_FORMAT_NOT_SUPPORTED");
      if (info.size < 1 || info.size > (migration ? 2 * 1024 ** 3 : this.capabilities?.document_max_bytes || 1024 * 1024 * 1024))
        throw fail2("SEMANTICA_FILE_TOO_LARGE");
      const existing = [...this.files.entries()].find(([, f]) => !f.result && f.path === filePath && f.warehouseId === warehouseId && f.migration === migration && f.size === info.size && f.mtime === info.mtimeMs);
      const handle = existing?.[0] || randomUUID(), operation = randomUUID();
      if (!existing) this.files.set(handle, {
        path: filePath,
        name,
        size: info.size,
        mtime: info.mtimeMs,
        operation,
        external: randomUUID(),
        offset: 0,
        warehouseId,
        migration
      });
      if (!result.some((f) => f.handle === handle)) result.push({ handle, name, size: info.size, format, source: "computer" });
    }
    this.assertLive();
    return result;
  }
  fileProblem(entry) {
    const format = path2.extname(entry.name).slice(1).toLowerCase();
    const accepted = this.capabilities?.accepted_suffixes?.map((x) => x.replace(/^\./, "")) || [...FORMATS];
    if (entry.kind !== "file" || entry.trashed != null) return "SPACE_NOT_FILE";
    if (!accepted.includes(format)) return "SEMANTICA_FORMAT_NOT_SUPPORTED";
    if (!Number.isSafeInteger(entry.size) || entry.size < 1) return "SPACE_EMPTY_FILE";
    if (entry.size > (this.capabilities?.document_max_bytes || 1024 ** 3)) return "SEMANTICA_FILE_TOO_LARGE";
    if (!/^[a-f0-9]{64}$/.test(entry.digest || "")) return "SPACE_CHUNK_INVALID";
    return null;
  }
  async spaceReady() {
    this.assertLive();
    if (!this.host.drive) throw fail2("SPACE_UPGRADE_REQUIRED");
    await (this.spaceCapability ||= this.host.drive.overview({ signal: this.controller.signal }).catch((error) => {
      this.spaceCapability = null;
      throw error;
    }));
    this.assertLive();
  }
  async spaceList(parent = "") {
    await this.spaceReady();
    const listing = await this.host.drive.list({ parent, signal: this.controller.signal });
    this.assertLive();
    return {
      parent: listing.parent,
      breadcrumbs: listing.breadcrumbs.map(({ id: id2, name }) => ({ id: id2, name })),
      items: listing.items.filter((e) => e.trashed == null).map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        size: e.size,
        digest: e.digest,
        format: path2.extname(e.name).slice(1).toLowerCase(),
        problem: e.kind === "folder" ? null : this.fileProblem(e)
      }))
    };
  }
  async chooseSpace(entries, warehouseId) {
    await this.spaceReady();
    if (!warehouseId || !Array.isArray(entries) || !entries.length || entries.length > 200)
      throw fail2("INVALID_RESOURCE");
    const selected = [];
    for (const selection of entries) {
      const entry = await this.host.drive.stat(selection.id, { signal: this.controller.signal });
      this.assertLive();
      const problem = this.fileProblem(entry);
      if (problem) throw fail2(problem);
      if (entry.digest !== selection.digest) throw fail2("SPACE_REMOTE_FILE_CHANGED");
      selected.push(entry);
    }
    const result = [];
    for (const entry of selected) {
      const existing = [...this.files.entries()].find(([, f]) => f.source === "space" && !f.result && f.warehouseId === warehouseId && f.id === entry.id && f.digest === entry.digest);
      const handle = existing?.[0] || randomUUID();
      const operation = randomUUID();
      if (!existing) this.files.set(handle, {
        source: "space",
        id: entry.id,
        name: entry.name,
        size: entry.size,
        digest: entry.digest,
        mtime: entry.modified,
        warehouseId,
        operation,
        offset: 0,
        external: "wanx-space:" + createHash("sha256").update(JSON.stringify([
          this.context?.accountId,
          this.context?.user?.id,
          this.context?.boxId
        ])).digest("hex") + ":" + entry.id + ":" + entry.digest + ":" + operation
      });
      if (!result.some((f) => f.handle === handle)) result.push({
        handle,
        name: entry.name,
        size: entry.size,
        source: "space",
        spaceId: entry.id,
        format: path2.extname(entry.name).slice(1).toLowerCase()
      });
    }
    return result;
  }
  async validateFile(file) {
    this.assertLive();
    if (file.source === "space") {
      const entry = await this.host.drive.stat(file.id, { signal: this.controller.signal });
      this.assertLive();
      if (entry.kind !== "file" || entry.trashed != null || entry.size !== file.size || entry.digest !== file.digest || entry.modified !== file.mtime || entry.name !== file.name)
        throw fail2("SPACE_REMOTE_FILE_CHANGED");
    } else {
      const info = await stat(file.path);
      this.assertLive();
      if (info.size !== file.size || info.mtimeMs !== file.mtime) throw fail2("SEMANTICA_LOCAL_FILE_CHANGED");
    }
  }
  async *fileChunks(file, offset) {
    if (file.source !== "space") {
      yield* createReadStream(file.path, { start: offset, highWaterMark: CHUNK });
      return;
    }
    let seen = 0;
    const hash = createHash("sha256");
    for await (const chunk of this.host.drive.read(file.id, { signal: this.controller.signal })) {
      this.assertLive();
      hash.update(chunk);
      if (seen + chunk.length > file.size) throw fail2("SPACE_REMOTE_FILE_CHANGED");
      let cursor = Math.min(chunk.length, Math.max(0, offset - seen));
      seen += chunk.length;
      while (cursor < chunk.length) {
        const end = Math.min(chunk.length, cursor + CHUNK);
        yield Buffer.from(chunk.buffer, chunk.byteOffset + cursor, end - cursor);
        cursor = end;
      }
    }
    if (seen !== file.size || hash.digest("hex") !== file.digest) throw fail2("SPACE_REMOTE_FILE_CHANGED");
  }
  async upload(handle, warehouseId) {
    this.assertLive();
    const file = this.files.get(handle);
    if (!file) throw fail2("SEMANTICA_FILE_SELECTION_EXPIRED");
    if (file.warehouseId !== warehouseId)
      throw fail2("SEMANTICA_FILE_SELECTION_EXPIRED");
    const prefix = file.migration ? "/warehouses" : warehouseId ? "/warehouses/" + resource(warehouseId) : "";
    const api = (endpoint, options) => this.api(prefix + endpoint, options);
    if (file.result) return file.result;
    await this.validateFile(file);
    let digest = file.digest;
    if (file.source !== "space") {
      const hash = createHash("sha256");
      for await (const data of createReadStream(file.path, { highWaterMark: CHUNK })) {
        this.assertLive();
        hash.update(data);
      }
      digest = hash.digest("hex");
    }
    this.emit({
      type: "upload",
      handle,
      state: "uploading",
      offset: 0,
      size: file.size
    });
    const begun = await api("/imports", {
      method: "POST",
      body: {
        operation_id: file.operation,
        external_document_id: file.external,
        filename: file.name,
        size_bytes: file.size,
        sha256: digest
      }
    });
    if (begun.document) {
      file.result = begun;
      return begun;
    }
    const uploadHandle = begun.upload_handle;
    resource(uploadHandle);
    let offset = Number(begun.offset ?? begun.received_bytes ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
      throw fail2("SEMANTICA_INVALID_RESPONSE");
    if (offset < file.size || file.source === "space") {
      for await (const data of this.fileChunks(file, offset)) {
        this.assertLive();
        await api("/imports/" + uploadHandle, {
          method: "PATCH",
          body: {
            operation_id: file.operation,
            offset,
            content_base64: data.toString("base64")
          }
        });
        offset += data.length;
        file.offset = offset;
        this.emit({
          type: "upload",
          handle,
          state: "uploading",
          offset,
          size: file.size
        });
      }
    }
    await this.validateFile(file);
    let result;
    try {
      result = await api("/imports/" + uploadHandle + "/commit", {
        method: "POST",
        body: { operation_id: file.operation }
      });
    } catch (error) {
      this.assertLive();
      if (file.migration) throw error;
      const reconciled = await api(
        "/operations/" + resource(file.operation)
      ).catch(() => null);
      if (reconciled?.status === "committed" && reconciled.result?.document)
        result = reconciled.result;
      else if (reconciled?.status === "committed" && reconciled.document)
        result = reconciled;
      else throw error;
    }
    file.result = result;
    this.emit({
      type: "upload",
      handle,
      state: "received",
      offset: file.size,
      size: file.size,
      documentId: result.document?.id
    });
    return result;
  }
  async download(input) {
    const id2 = resource(input.id);
    this.assertLive();
    const prefix = input.warehouseId ? "/warehouses/" + resource(input.warehouseId) : "";
    const detail = await this.api(prefix + "/documents/" + id2);
    const filename = path2.basename(String(detail.document.original_name));
    const output = await this.selectSave(filename);
    if (!output) return { canceled: true };
    this.assertLive();
    const temporary = output + ".semantica-" + randomUUID() + ".tmp";
    const stream = await open(temporary, "wx", 384);
    const hash = createHash("sha256");
    let offset = 0, total = null, revision = null, digest = null;
    try {
      while (total === null || offset < total) {
        const query = new URLSearchParams({
          offset: String(offset),
          length: String(CHUNK)
        });
        if (revision !== null) {
          query.set("expected_origin_revision", String(revision));
          query.set("expected_sha256", digest);
        }
        const chunk = await this.api(
          prefix + "/documents/" + id2 + "/blob?" + query
        );
        if (total === null) {
          total = chunk.total_bytes;
          revision = chunk.origin_revision;
          digest = chunk.sha256;
          if (!Number.isSafeInteger(total) || total < 0 || total > 1024 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(digest))
            throw fail2("SEMANTICA_INVALID_RESPONSE");
        }
        const bytes = Buffer.from(chunk.content_base64, "base64");
        if (chunk.offset !== offset || chunk.total_bytes !== total || chunk.sha256 !== digest || bytes.length !== chunk.length || bytes.length > CHUNK || offset + bytes.length > total || !bytes.length && offset < total)
          throw fail2("SEMANTICA_INVALID_RESPONSE");
        hash.update(bytes);
        await stream.writeFile(bytes);
        offset += bytes.length;
      }
      this.assertLive();
      await stream.close();
      if (hash.digest("hex") !== digest)
        throw fail2("SEMANTICA_DOWNLOAD_HASH_MISMATCH");
      await rename(temporary, output);
      return { saved: true };
    } catch (error) {
      await stream.close().catch(() => {
      });
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async saveMigration(id2) {
    const transfer = await this.api("/warehouses/transfers/" + id2);
    if (transfer.kind !== "export" || transfer.state !== "ready")
      throw fail2("MIGRATION_NOT_READY");
    const total = transfer.size_bytes, digest = transfer.sha256;
    if (!Number.isSafeInteger(total) || total <= 0 || total > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(digest))
      throw fail2("SEMANTICA_INVALID_RESPONSE");
    const output = await this.selectSave(
      path2.basename(transfer.result.filename || "\u661F\u56FE\u6570\u636E\u4ED3.xingtu")
    );
    if (!output) return { canceled: true };
    this.assertLive();
    const temporary = output + ".xingtu-" + randomUUID() + ".tmp";
    const stream = await open(temporary, "wx", 384), hash = createHash("sha256");
    let offset = 0;
    try {
      while (offset < total) {
        const chunk = await this.api(
          "/warehouses/transfers/" + id2 + "/blob?" + new URLSearchParams({
            offset: String(offset),
            length: String(CHUNK)
          })
        );
        const data = Buffer.from(chunk.content_base64, "base64");
        if (chunk.offset !== offset || chunk.total_bytes !== total || chunk.sha256 !== digest || chunk.length !== data.length || !data.length || data.length > CHUNK || offset + data.length > total)
          throw fail2("SEMANTICA_INVALID_RESPONSE");
        hash.update(data);
        await stream.writeFile(data);
        offset += data.length;
        this.emit({ type: "migration-download", offset, size: total });
      }
      this.assertLive();
      await stream.close();
      if (hash.digest("hex") !== digest)
        throw fail2("SEMANTICA_DOWNLOAD_HASH_MISMATCH");
      await rename(temporary, output);
      return { saved: true };
    } catch (error) {
      await stream.close().catch(() => {
      });
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async call(action, input = {}) {
    this.assertLive();
    const warehouse = input.warehouseId ? resource(input.warehouseId) : null;
    const api = (endpoint, options) => this.api(
      (warehouse ? "/warehouses/" + warehouse : "") + endpoint,
      options
    );
    if (["skills", "skill", "import-skill", "download-skill", "delete-skill", "reasoning"].includes(action) && !warehouse) throw fail2("INVALID_RESOURCE");
    switch (action) {
      case "select-warehouse":
        this.warehouseGeneration++;
        return { selected: true };
      case "skills":
        return api("/skills?limit=20&offset=" + (Number(input.offset) || 0) + "&keyword=" + encodeURIComponent(input.keyword || ""));
      case "skill":
        return api("/skills/" + resource(input.id) + "?path=" + encodeURIComponent(input.path || "SKILL.md"));
      case "import-skill": {
        const generation = this.controller, warehouseGeneration = this.warehouseGeneration;
        const selected = await this.selectSkill();
        this.assertLive();
        if (!selected?.length) return null;
        if (warehouseGeneration !== this.warehouseGeneration) throw fail2("WAREHOUSE_CHANGED");
        const file = selected[0], info = await stat(file);
        if (!info.isFile() || !file.toLowerCase().endsWith(".zip") || info.size > 4 * 1024 * 1024) throw fail2("SKILL_TOO_LARGE");
        const data = await readFile2(file), after = await stat(file);
        if (data.length !== info.size || after.mtimeMs !== info.mtimeMs || generation !== this.controller) throw fail2("SEMANTICA_LOCAL_FILE_CHANGED");
        return api("/skills/import", { method: "POST", body: { operation_id: input.operationId || randomUUID(), content_base64: data.toString("base64") } });
      }
      case "download-skill": {
        const warehouseGeneration = this.warehouseGeneration;
        const blob = await api("/skills/" + resource(input.id) + "/download");
        const data = Buffer.from(blob.content_base64, "base64");
        if (data.length > 8 * 1024 * 1024 || createHash("sha256").update(data).digest("hex") !== blob.sha256) throw fail2("SEMANTICA_DOWNLOAD_HASH_MISMATCH");
        const target = await this.selectSave(path2.basename(blob.filename));
        this.assertLive();
        if (warehouseGeneration !== this.warehouseGeneration) throw fail2("WAREHOUSE_CHANGED");
        if (target) await writeFile(target, data);
        return { saved: !!target };
      }
      case "delete-skill":
        return api("/skills/" + resource(input.id) + "/delete", { method: "POST", body: { ...input.confirmation, operation_id: input.operationId || randomUUID() } });
      case "reasoning": {
        if (!["discover", "prepare", "reference", "scope", "search", "evidence", "read-document", "coverage"].includes(input.operation)) throw fail2("INVALID_RESOURCE");
        return api("/reasoning/" + input.operation, { method: "POST", body: { operation_id: input.operationId || randomUUID(), arguments: input.arguments || {} }, timeoutMs: 33e4 });
      }
      case "processing":
        return this.api("/processing" + (input.scope === "default" || !warehouse ? "" : "?warehouse_id=" + warehouse));
      case "model-catalog":
        return this.api("/processing/catalog");
      case "check-models":
      case "save-models":
        return this.api("/processing" + (action === "check-models" ? "/check" : ""), { method: action === "check-models" ? "POST" : "PUT", body: { ...input.config, warehouse_id: input.scope === "default" ? null : warehouse, operation_id: randomUUID() }, timeoutMs: 33e4 });
      case "reprocess-models":
        return this.api("/processing/reprocess", { method: "POST", body: { operation_id: input.operationId || randomUUID(), warehouse_id: warehouse, documents: input.documents, expected_signature: input.expectedSignature } });
      case "initialize":
        return this.initialize();
      case "space-list":
        return this.spaceList(input.parent || "");
      case "select-space-files":
        return this.chooseSpace(input.entries, warehouse);
      case "release-files":
        for (const handle of input.handles || []) {
          if (this.files.get(handle)?.warehouseId === warehouse) this.files.delete(handle);
        }
        return { released: true };
      case "select-files":
        return this.choose(warehouse);
      case "select-migration":
        return this.choose(null, true);
      case "upload":
        return this.upload(resource(input.handle), warehouse);
      case "import-migration":
        return this.upload(resource(input.handle), null);
      case "warehouses":
        return this.api("/warehouses");
      case "runtime":
        return this.api("/warehouses/runtime");
      case "rename-warehouse": {
        const rename2 = validatedWarehouseRename(input);
        return this.api("/warehouses/" + rename2.warehouseId, {
          method: "PATCH",
          body: { name: rename2.name, operation_id: rename2.operationId }
        });
      }
      case "create-warehouse":
        return this.api("/warehouses", {
          method: "POST",
          body: {
            operation_id: resource(input.operationId),
            name: input.name,
            description: input.description || ""
          }
        });
      case "warehouse": {
        const prefix = "/warehouses/" + resource(input.id);
        const detail = await this.api(prefix);
        let ontology_labels = null;
        if (detail.current_ontology?.id && detail.current_ontology.status === "published") {
          try {
            const versions = await this.api(prefix + "/workbench/ontologies");
            const current = versions.items?.find((v) => v.id === detail.current_ontology.id && v.status === "published");
            const labels = (values) => Object.fromEntries((Array.isArray(values) ? values : []).filter((v) => typeof v.name === "string" && v.name && typeof v.label === "string" && v.label.trim()).map((v) => [v.name, v.label]));
            if (current?.schema) ontology_labels = { entities: labels(current.schema.entity_types), relations: labels(current.schema.relation_types) };
          } catch (error) {
            if (/SESSION|AUTH|FORBIDDEN/.test(error.code || error.message || "")) throw error;
          }
        }
        return { ...detail, ontology_labels };
      }
      case "keys":
        return api("/keys");
      case "create-key":
        return api("/keys", {
          method: "POST",
          body: {
            operation_id: resource(input.operationId),
            name: input.name,
            scopes: input.scopes ?? ["documents", "evidence", "graph", "reasoning", "search"],
            days: input.days
          }
        });
      case "revoke-key":
        return api("/keys/" + resource(input.id) + "/revoke", {
          method: "POST",
          body: { operation_id: resource(input.operationId) }
        });
      case "prepare-clear":
        return api("/clear/prepare", {
          method: "POST",
          body: { operation_id: resource(input.operationId) }
        });
      case "prepare-delete":
        return api("/delete/prepare", {
          method: "POST",
          body: { operation_id: resource(input.operationId) }
        });
      case "delete-warehouse": {
        const result = await api("/delete", {
          method: "POST",
          body: {
            operation_id: resource(input.operationId),
            confirmation_token: input.token,
            typed_name: input.typedName
          }
        });
        for (const [handle, file] of this.files)
          if (file.warehouseId === warehouse) this.files.delete(handle);
        return result;
      }
      case "clear-warehouse": {
        const result = await api("/clear", {
          method: "POST",
          body: {
            operation_id: resource(input.operationId),
            confirmation_token: input.token,
            typed_name: input.typedName
          }
        });
        for (const [handle, file] of this.files)
          if (file.warehouseId === warehouse) this.files.delete(handle);
        return result;
      }
      case "export-warehouse":
        return api("/exports", {
          method: "POST",
          body: { operation_id: resource(input.operationId) }
        });
      case "transfers":
        return this.api("/warehouses/transfers");
      case "transfer":
        return this.api("/warehouses/transfers/" + resource(input.id));
      case "save-migration":
        return this.saveMigration(resource(input.id));
      case "documents":
        return api(
          "/documents?" + new URLSearchParams({
            limit: "100",
            offset: String(input.offset || 0)
          })
        );
      case "document":
        return api(
          "/documents/" + resource(input.id) + "?" + new URLSearchParams({
            segment_offset: String(input.offset || 0),
            segment_limit: "100"
          })
        );
      case "jobs":
        return api(
          "/jobs?" + new URLSearchParams({
            limit: "100",
            offset: String(input.offset || 0)
          })
        );
      case "graph":
        return api("/owner/graph?limit=120");
      case "retrieval":
        return api("/retrieval/status");
      case "search":
        return api("/search", {
          method: "POST",
          body: {
            query: input.query,
            document_ids: input.documentIds || [],
            entity_types: input.entityTypes || [],
            limit: 10
          },
          timeoutMs: 9e4
        });
      case "sensitive":
        return api("/sensitive/settings");
      case "save-sensitive":
        return api("/sensitive/settings", {
          method: "PUT",
          body: {
            operation_id: resource(input.operationId),
            payload: input.payload
          }
        });
      case "correct":
        return api("/documents/" + resource(input.id) + "/correction", {
          method: "POST",
          body: {
            operation_id: resource(input.operationId),
            payload: {
              base_version_id: resource(input.versionId),
              segments: input.segments
            }
          }
        });
      case "delete-document":
        return api("/documents/" + resource(input.id), {
          method: "DELETE",
          body: { operation_id: resource(input.operationId), expected_version_id: input.versionId }
        });
      case "retry-job":
        return api("/jobs/" + resource(input.id) + "/retry", {
          method: "POST",
          body: { operation_id: resource(input.operationId) }
        });
      case "build-index":
        return api("/retrieval/indexes", {
          method: "POST",
          body: { operation_id: resource(input.operationId) }
        });
      case "download":
        return this.download(input);
      default:
        throw fail2("SEMANTICA_OPERATION_NOT_ALLOWED");
    }
  }
  close() {
    this.unsubscribe?.();
    this.controller.abort();
    this.files.clear();
    this.host?.close();
  }
};

// ../builder/integration/team-client/data-service.mjs
var import_drive = __toESM(require_drive(), 1);

// ../builder/integration/team-client/data-share-service.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
var fail3 = (code) => Object.assign(new Error(code), { code });
var actions = /* @__PURE__ */ new Set(["share-details", "create-share-key", "revoke-share-key", "reveal-share-key", "copy-share-key", "copy-share-value", "release-share-key"]);
var nativeBase = "/api/semantica/open/v1";
var nativeScopes = ["documents", "evidence", "graph", "search"];
var nativeExample = `const response = await host.request("${nativeBase}/graph?limit=120", {
  headers: { "X-Xingtu-Key": process.env.STARLINK_KEY }
});`;
function createDataShareAccess({ identity, instance, writeClipboard, getMcpDetails }) {
  const secrets = /* @__PURE__ */ new Map();
  const clear = () => {
    secrets.clear();
  };
  async function action(action2, input = {}) {
    if (action2 === "release-share-key") {
      secrets.delete(input.handle);
      return { released: true };
    }
    const { next } = await identity(), warehouseId = input.warehouseId;
    if (typeof warehouseId !== "string" || !/^[a-f0-9-]{36}$/.test(warehouseId)) throw fail3("TEAM_DATA_TARGET_INVALID");
    const live = async () => {
      if ((await identity()).next !== next) throw fail3("TEAM_SESSION_CHANGED");
    };
    const service = await instance(), warehouse = await service.call("warehouse", { id: warehouseId });
    const listKeys = () => service.call("keys", { warehouseId });
    await live();
    if (action2 === "share-details") {
      const keys = await listKeys(), mcp = await getMcpDetails?.();
      await live();
      const runtime = await service.call("runtime");
      await live();
      return { warehouse: { id: warehouse.id, name: warehouse.name }, mcpUrl: mcp?.url || null, mcpConfiguration: mcp?.configuration || null, hostBase: nativeBase, localBase: runtime.api_base_url || null, hostExample: nativeExample, keys: keys.items || [], scopes: nativeScopes, sessionBound: false };
    }
    if (action2 === "create-share-key") {
      const name = String(input.name || "").trim(), days = Number(input.days);
      if (!name || name.length > 60 || !Number.isInteger(days) || days < 1 || days > 365) throw fail3("TEAM_DATA_SHARE_INVALID");
      const grant = await service.call("create-key", { warehouseId, name, days, scopes: nativeScopes, operationId: randomUUID2() });
      await live();
      if (!grant.token) throw fail3("TEAM_DATA_KEY_NOT_REPLAYABLE");
      const handle = randomUUID2();
      secrets.clear();
      secrets.set(handle, { warehouseId, keyId: grant.key.id, token: grant.token, scope: next });
      return { key: grant.key, handle, oneTimeDisplay: true };
    }
    if (action2 === "revoke-share-key") {
      const result = await service.call("revoke-key", { warehouseId, id: input.keyId, operationId: randomUUID2() });
      await live();
      return result;
    }
    if (["reveal-share-key", "copy-share-key"].includes(action2)) {
      const value = secrets.get(input.handle);
      if (!value || value.scope !== next || value.warehouseId !== warehouseId) throw fail3("TEAM_DATA_KEY_NOT_REPLAYABLE");
      const keys = await listKeys();
      if (!keys.items.some((key) => key.id === value.keyId && !key.revoked_at && key.expires_at * 1e3 > Date.now())) {
        secrets.delete(input.handle);
        throw fail3("TEAM_DATA_KEY_REVOKED");
      }
      await live();
      if (action2 === "reveal-share-key") return { token: value.token };
      if (!writeClipboard) throw fail3("TEAM_CLIPBOARD_UNAVAILABLE");
      writeClipboard(value.token);
      return { copied: true };
    }
    if (action2 === "copy-share-value") {
      if (["host-base", "host-example", "local-base"].includes(input.kind)) {
        const text2 = input.kind === "host-base" ? nativeBase : input.kind === "host-example" ? nativeExample : (await service.call("runtime")).api_base_url;
        await live();
        if (typeof text2 !== "string" || !text2) throw fail3("TEAM_DATA_SHARE_INVALID");
        if (!writeClipboard) throw fail3("TEAM_CLIPBOARD_UNAVAILABLE");
        writeClipboard(text2);
        return { copied: true };
      }
      if (!["mcp-url", "mcp-config"].includes(input.kind)) throw fail3("TEAM_DATA_SHARE_INVALID");
      const mcp = await getMcpDetails?.(), text = input.kind === "mcp-url" ? mcp?.url : mcp?.configuration ? JSON.stringify(mcp.configuration, null, 2) : null;
      if (typeof text !== "string" || !text) throw fail3("TEAM_DATA_SHARE_INVALID");
      await live();
      if (!writeClipboard) throw fail3("TEAM_CLIPBOARD_UNAVAILABLE");
      writeClipboard(text);
      return { copied: true };
    }
    throw fail3("TEAM_DATA_ACTION_DENIED");
  }
  return { supports: (name) => actions.has(name), action, clear };
}

// ../builder/integration/team-client/data-service.mjs
var fail4 = (code) => Object.assign(new Error(code), { code });
var ID2 = "centaurai.wanx.semantica";
var ACTIONS = /* @__PURE__ */ new Set(["initialize", "warehouses", "warehouse", "create-warehouse", "rename-warehouse", "select-warehouse", "documents", "document", "delete-document", "correct", "document-text", "evidence", "authorization-summary", "jobs", "graph", "retrieval", "search", "retry-job", "build-index", "processing", "reprocess-models", "select-files", "select-space-files", "space-list", "release-files", "upload"]);
var VIEWS = /* @__PURE__ */ new Set(["warehouses", "conversation", "materials", "graph", "search", "tasks", "sensitive", "models", "skills", "reasoning", "api", "data"]);
var SOURCE_ACTIONS = /* @__PURE__ */ new Set(["document-text", "evidence", "authorization-summary"]);
var GOVERNANCE_ACTIONS = /* @__PURE__ */ new Set(["governance-summary", "governance-reviews", "governance-detail", "governance-resolve", "governance-flag", "governance-propose", "governance-apply", "governance-unflag"]);
function operationId(value, required = false) {
  if (value === void 0 && !required) return randomUUID3();
  if (typeof value !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw fail4("TEAM_DATA_TARGET_INVALID");
  return value;
}
function governanceRequest(action, input) {
  const writing = !["governance-summary", "governance-reviews", "governance-detail"].includes(action);
  const fields = {
    "governance-summary": [],
    "governance-reviews": ["offset", "limit"],
    "governance-detail": ["reviewId"],
    "governance-resolve": ["reviewId", "actionId", "reason"],
    "governance-flag": ["kind", "targetId", "reason"],
    "governance-propose": ["reviewId", "reason"],
    "governance-apply": ["proposalId", "confirmed"],
    "governance-unflag": ["reviewId"]
  }[action];
  const allowed = ["warehouseId", ...fields, ...writing ? ["operationId", "expectedRevision"] : []];
  if (!input || Array.isArray(input) || Object.keys(input).some((k) => !allowed.includes(k)) || typeof input.warehouseId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.warehouseId)) throw fail4("TEAM_DATA_TARGET_INVALID");
  const resource2 = (value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail4("TEAM_DATA_TARGET_INVALID");
    return value;
  };
  const prefix = "/warehouses/" + input.warehouseId + "/workbench/governance";
  if (action === "governance-summary") return { path: prefix + "/summary" };
  if (action === "governance-reviews") {
    const offset = input.offset ?? 0, limit = input.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw fail4("TEAM_DATA_TARGET_INVALID");
    return { path: prefix + "/reviews?" + new URLSearchParams({ offset: String(offset), limit: String(limit) }) };
  }
  if (action === "governance-detail") return { path: prefix + "/reviews/" + resource2(input.reviewId) };
  const operation = operationId(input.operationId, true), revision = input.expectedRevision;
  if (!Number.isSafeInteger(revision) || revision < (action === "governance-flag" ? 0 : 1)) throw fail4("TEAM_DATA_TARGET_INVALID");
  const body = { operation_id: operation, expected_revision: revision, _native_operation_id: operation };
  if (Object.hasOwn(input, "reason")) {
    if (typeof input.reason !== "string" || input.reason.length > 2e3) throw fail4("TEAM_DATA_TARGET_INVALID");
    body.reason = input.reason.trim();
  }
  let endpoint;
  if (action === "governance-flag") {
    if (!["entity", "relation"].includes(input.kind)) throw fail4("TEAM_DATA_TARGET_INVALID");
    Object.assign(body, { kind: input.kind, target_id: resource2(input.targetId), reason: body.reason ?? "\u7528\u6237\u6807\u8BB0\u5F85\u6838\u5BF9" });
    endpoint = "/flag";
  } else if (action === "governance-resolve") {
    body.action_id = resource2(input.actionId);
    endpoint = "/reviews/" + resource2(input.reviewId) + "/resolve";
  } else if (action === "governance-propose") {
    if (!body.reason) throw fail4("TEAM_DATA_TARGET_INVALID");
    body.review_id = resource2(input.reviewId);
    endpoint = "/proposals";
  } else if (action === "governance-apply") {
    if (input.confirmed !== true) throw fail4("TEAM_DATA_TARGET_INVALID");
    body.confirmed = true;
    endpoint = "/proposals/" + resource2(input.proposalId) + "/apply";
  } else {
    body.review_id = resource2(input.reviewId);
    endpoint = "/unflag";
  }
  return { path: prefix + endpoint, options: { method: "POST", body, timeoutMs: 33e4 } };
}
function sourcePath(action, input) {
  const fields = action === "document-text" ? ["warehouseId", "id", "versionId", "start", "end"] : action === "evidence" ? ["warehouseId", "id"] : ["warehouseId"];
  if (!input || Array.isArray(input) || Object.keys(input).some((k) => !fields.includes(k)) || typeof input.warehouseId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.warehouseId)) throw fail4("TEAM_DATA_TARGET_INVALID");
  const prefix = "/warehouses/" + input.warehouseId;
  if (action === "authorization-summary") return prefix;
  if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id)) throw fail4("TEAM_DATA_TARGET_INVALID");
  if (action === "evidence") return prefix + "/evidence/" + encodeURIComponent(input.id);
  const start = input.start ?? 0, end = input.end;
  if (typeof input.versionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.versionId) || !Number.isSafeInteger(start) || start < 0 || end !== void 0 && (!Number.isSafeInteger(end) || end <= start || end - start > 65536)) throw fail4("TEAM_DATA_TARGET_INVALID");
  return prefix + "/documents/" + encodeURIComponent(input.id) + "/text?" + new URLSearchParams({ version_id: input.versionId, start: String(start), ...end !== void 0 ? { end: String(end) } : {} });
}
async function authorizationSummary(service, warehouseId) {
  const warehouse = await service.call("warehouse", { id: warehouseId }), keys = await service.call("keys", { warehouseId });
  if (warehouse?.id !== warehouseId || !Array.isArray(keys?.items) || keys.items.some((k) => !k || !Number.isFinite(k.expires_at))) throw fail4("TEAM_DATA_RESPONSE_INVALID");
  const now = Date.now() / 1e3;
  return {
    warehouseId,
    warehouse: { id: warehouseId, name: warehouse.name },
    active_count: keys.items.filter((k) => !k.revoked_at && k.expires_at > now).length,
    expired_count: keys.items.filter((k) => !k.revoked_at && k.expires_at <= now).length,
    revoked_count: keys.items.filter((k) => k.revoked_at).length
  };
}
function starlinkTarget(input = {}) {
  if (Object.keys(input).some((k) => !["warehouseId", "view"].includes(k)) || input.warehouseId != null && !/^[a-f0-9-]{36}$/.test(input.warehouseId) || !VIEWS.has(input.view || "graph")) throw fail4("TEAM_DATA_TARGET_INVALID");
  return { kind: "team-data", version: 1, warehouseId: input.warehouseId || null, view: input.view || "graph" };
}
function createBaseTeamDataService({ client, applications, selectFiles, starlinkPackageDir, writeClipboard, getMcpDetails, emit = () => {
} }) {
  let service, serviceConnection, creating, scopeKey, share, disposed = false, scopeRevision = 0;
  const key = () => {
    const s = client.snapshot();
    return s.phase === "ready" ? JSON.stringify([s.account?.accountId, s.account?.clientId, s.connection?.deviceId]) : null;
  };
  const invalidate = () => {
    scopeRevision++;
    const old = service;
    service = null;
    serviceConnection = null;
    creating = null;
    scopeKey = null;
    old?.close();
    share?.clear();
    emit({ type: "invalidated" });
  };
  const stop = client.subscribe(() => {
    if (scopeKey && scopeKey !== key()) invalidate();
  });
  async function identity() {
    if (disposed) throw fail4("TEAM_SESSION_CHANGED");
    const next = key();
    if (!next) throw fail4("TEAM_SESSION_CHANGED");
    const connection2 = await client.applicationConnection("wanx");
    const context = connection2.context(), state = client.snapshot();
    if (context.protocolVersion !== 1 || context.authorization != null || context.dataIdentity || state.account?.phase !== "authenticated" || !context.accountId || !context.clientId || !context.boxId || context.accountId !== state.account.accountId || context.clientId !== state.account.clientId || context.boxId !== state.connection?.deviceId) {
      invalidate();
      throw fail4("TEAM_IDENTITY_INVALID");
    }
    const response = await connection2.request({ path: "/api/auth/me" });
    if (next !== key()) throw fail4("TEAM_SESSION_CHANGED");
    if (response.status !== 200) {
      invalidate();
      throw fail4("TEAM_LOGIN_EXPIRED");
    }
    const me = JSON.parse(response.body.toString("utf8"));
    if (me.role !== "admin" || me.application_id !== "wanx" || !Number.isSafeInteger(me.id) || me.id <= 0 || me.id !== context.user?.id) {
      invalidate();
      throw fail4("TEAM_ADMIN_REQUIRED");
    }
    if (scopeKey && scopeKey !== next) invalidate();
    scopeKey = next;
    return { connection: connection2, me, next };
  }
  async function connection(target) {
    const { connection: base, me, next } = await identity();
    const assertLive = () => {
      base.context();
      if (next !== key()) throw fail4("TEAM_SESSION_CHANGED");
    };
    return {
      ...base,
      context: () => {
        assertLive();
        return { ...base.context(), user: me, dataScope: "team", starlinkTarget: target || null };
      },
      async request(input) {
        assertLive();
        await identity();
        assertLive();
        const headers = { ...input.headers };
        delete headers["x-wanx-data-context"];
        if (/^\/api\/semantica\//.test(input.path) && !input.path.startsWith("/api/semantica/open/")) headers["x-wanx-data-context"] = "team";
        const result = await base.request({ ...input, headers });
        assertLive();
        return result;
      }
    };
  }
  async function instance() {
    await identity();
    if (service) {
      try {
        service.assertLive();
        serviceConnection.context();
        return service;
      } catch {
        invalidate();
        await identity();
      }
    }
    if (creating) return creating;
    const version = scopeRevision;
    const pending = (async () => {
      const base = await connection();
      if (version !== scopeRevision) throw fail4("TEAM_SESSION_CHANGED");
      let candidate;
      const host = {
        context: async () => base.context(),
        // Platform subscribe emits health/directory snapshots too. Only a dead
        // captured connection invalidates this service, never a healthy snapshot.
        onSessionInvalidated: (notify) => base.subscribe(() => {
          try {
            base.context();
            return;
          } catch {
          }
          if (service === candidate) invalidate();
          notify({ type: "invalidated", code: "HOST_SESSION_EXPIRED" });
        }),
        close() {
        },
        async request(path4, options = {}) {
          let { body, headers = {}, method = "GET" } = options;
          if (body != null && !(body instanceof Uint8Array)) {
            body = Buffer.from(JSON.stringify(body));
            headers = { ...headers, "content-type": "application/json" };
          }
          const r = await base.request({ path: path4, method, headers, ...body != null ? { body } : {} });
          return new Response(r.body.length ? r.body : null, { status: r.status, headers: r.headers });
        }
      };
      host.drive = import_drive.default.createDriveClient(host);
      candidate = new SemanticaService({ host, selectFiles, emit });
      try {
        candidate.context = base.context();
        candidate.assertLive();
        if (version !== scopeRevision) throw fail4("TEAM_SESSION_CHANGED");
      } catch (error) {
        candidate.close();
        throw error;
      }
      service = candidate;
      serviceConnection = base;
      return candidate;
    })();
    creating = pending;
    try {
      return await pending;
    } finally {
      if (creating === pending) creating = null;
    }
  }
  share = createDataShareAccess({ identity, instance, writeClipboard, getMcpDetails });
  async function installStarlink() {
    if (!starlinkPackageDir) throw fail4("TEAM_STARLINK_NOT_INSTALLED");
    const temporary = await mkdtemp(path3.join(os.tmpdir(), "wanx-starlink-"));
    async function materialize(source, target) {
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const from = path3.join(source, entry.name), to = path3.join(target, entry.name);
        if (entry.isDirectory()) await materialize(from, to);
        else if (entry.isFile()) await writeFile2(to, await readFile3(from), { flag: "wx" });
        else throw fail4("TEAM_STARLINK_PACKAGE_INVALID");
      }
    }
    try {
      await materialize(starlinkPackageDir, path3.join(temporary, "package"));
      await identity();
      const installed = await applications.install({ sourceDir: path3.join(temporary, "package") });
      await identity();
      return installed;
    } finally {
      await rm2(temporary, { recursive: true, force: true });
    }
  }
  return {
    connection,
    async action(action, input = {}) {
      if (action === "release-share-key") return share.action(action, input);
      await identity();
      if (share.supports(action)) return share.action(action, input);
      if (action === "install-starlink") return installStarlink();
      if (action === "open-starlink") {
        const target = starlinkTarget(input);
        if (target.warehouseId) await (await instance()).call("warehouse", { id: target.warehouseId });
        const installed = (await applications.listInstalled()).find((a) => a.applicationId === ID2);
        if (await needsBundledStarlink(installed, starlinkPackageDir, applications)) await installStarlink();
        return applications.launch({ applicationId: ID2, launchContext: target });
      }
      if (!ACTIONS.has(action) && !GOVERNANCE_ACTIONS.has(action)) throw fail4("TEAM_DATA_ACTION_DENIED");
      if (action === "correct") input = validatedCorrection(input);
      if (action === "rename-warehouse") input = validatedWarehouseRename(input);
      if (action === "delete-document") input = validatedDeletion(input);
      const source = SOURCE_ACTIONS.has(action) ? sourcePath(action, input) : null;
      const governance = GOVERNANCE_ACTIONS.has(action) ? governanceRequest(action, input) : null;
      if (action === "select-warehouse" && input.warehouseId && !/^[a-f0-9-]{36}$/.test(input.warehouseId)) throw fail4("TEAM_DATA_TARGET_INVALID");
      if (action === "create-warehouse") input = { name: input.name, description: input.description || "", operationId: operationId(input.operationId) };
      if (["retry-job", "build-index"].includes(action)) input = { ...input, operationId: operationId(input.operationId) };
      const active = await instance();
      if (governance) {
        try {
          return await active.api(governance.path, governance.options);
        } catch (error) {
          if (action !== "governance-summary" || error.code !== "SEMANTICA_OPERATION_NOT_ALLOWED") throw error;
          return { supported: false };
        }
      }
      if (source) return action === "authorization-summary" ? authorizationSummary(active, input.warehouseId) : active.api(source);
      if (["select-files", "select-space-files", "upload"].includes(action) && !active.capabilities) active.capabilities = await active.api("/capabilities");
      return active.call(action, input);
    },
    close() {
      disposed = true;
      stop();
      invalidate();
    }
  };
}
var createTeamDataService = (options) => assistantAwareTeamDataService(createBaseTeamDataService, options);
export {
  createTeamDataService,
  starlinkTarget
};
