"""The protocol-3 expert client contract; standard archive identity stays intact."""
from copy import deepcopy
import hashlib
import re
from ..contracts import StudioError
from ..standard_package import validate_standard_package
from .contracts import canonicalize_json

CLIENT_FORMAT="wanx-standard-expert-client-v1"
CONTRACT={"id":"wanx.expert-app.v1","version":"1.0.0","features":["context","expert","data"]}
RUNTIME_CONTRACT={"id":CONTRACT["id"],"version":CONTRACT["version"],"collections":{"state":{"json":"string"}}}
MANIFEST_CONTRACT={"id":CONTRACT["id"],"range":">=1.0.0 <2.0.0","features":CONTRACT["features"]}


def is_standard(value):
    return isinstance(value,dict) and value.get("format")==CLIENT_FORMAT


def metadata(value):
    return {key:deepcopy(item) for key,item in value.items() if key!="packageBase64"}


def delivery_digest(value):
    return "sha256:"+hashlib.sha256(canonicalize_json(metadata(value) if is_standard(value) else value).encode()).hexdigest()


def runtime_manifest(value):
    if not is_standard(value):return deepcopy(value["manifest"])
    # Only an internal data-schema projection; never a generated/installable miniapp.
    return {**deepcopy(value["manifest"]),"collections":deepcopy(value["runtimeContract"]["collections"])}


def validate_client(value, *, archive=True):
    required={"format","applicationId","name","version","artifactHash","manifest","packageSha256","runtimeNamespace","runtimeContract"}
    if archive:required.add("packageBase64")
    if not is_standard(value) or set(value)!=required or value.get("runtimeNamespace")!="studio" or value.get("runtimeContract")!=RUNTIME_CONTRACT:raise StudioError("STANDARD_EXPERT_CLIENT_INVALID",422)
    manifest=value["manifest"]
    if not isinstance(manifest,dict) or not isinstance(value.get("name"),str) or not value["name"].strip() or len(value["name"])>80 or any(value.get(key)!=manifest.get(key) for key in ("applicationId","name","version")) or not re.fullmatch(r"[a-f0-9]{64}",str(value.get("artifactHash"))) or not re.fullmatch(r"[a-f0-9]{64}",str(value.get("packageSha256"))):raise StudioError("STANDARD_EXPERT_CLIENT_INVALID",422)
    compatibility=manifest.get("compatibility",{})
    if not isinstance(compatibility,dict) or manifest.get("capabilities")!=["identity.read","http.request"] or compatibility.get("backendProductId")!="wanx" or compatibility.get("backendContracts")!=[MANIFEST_CONTRACT] or compatibility.get("resourceDependencies")!=[]:raise StudioError("EXPERT_CLIENT_CAPABILITY_UNSUPPORTED",409)
    if archive:validate_standard_package(value["packageBase64"],value["packageSha256"],manifest,application_id=value["applicationId"],version=value["version"])
    return deepcopy(value)
