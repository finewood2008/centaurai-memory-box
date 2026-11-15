#!/usr/bin/env bash
set -euo pipefail
script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
edition=personal
out=""
out_index=-1
out_inline=false
has_channel=false
formal=false
local_mode=false
test_mode=false
has_notary_profile=false
has_trust_file=false
help=false
args=()
defaults=()

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --formal) formal=true; shift ;;
    --local) local_mode=true; args+=("$1"); shift ;;
    --test) test_mode=true; args+=("$1"); shift ;;
    --edition)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "$1 需要参数值。"
      edition="$2"
      shift 2
      ;;
    --edition=*) edition="${1#*=}"; shift ;;
    --out)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "$1 需要参数值。"
      out="$2"
      args+=("$1" "$2")
      out_index=$((${#args[@]} - 1))
      out_inline=false
      shift 2
      ;;
    --out=*)
      out="${1#*=}"
      [[ -n "$out" ]] || fail "--out 需要参数值。"
      args+=("$1")
      out_index=$((${#args[@]} - 1))
      out_inline=true
      shift
      ;;
    --help) help=true; args+=("$1"); shift ;;
    --channel=*) has_channel=true; args+=("$1"); shift ;;
    --notary-profile=*|--trust-file=*)
      [[ -n "${1#*=}" ]] || fail "${1%%=*} 需要参数值。"
      if [[ "$1" == --notary-profile=* ]]; then has_notary_profile=true; else has_trust_file=true; fi
      args+=("$1"); shift
      ;;
    --version|--arch|--notary-profile|--trust-file|--channel|--security-epoch|--test-run-id|--test-feed-url|--test-ca)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "$1 需要参数值。"
      if [[ "$1" == --channel ]]; then has_channel=true; fi
      if [[ "$1" == --notary-profile ]]; then has_notary_profile=true; fi
      if [[ "$1" == --trust-file ]]; then has_trust_file=true; fi
      args+=("$1" "$2")
      shift 2
      ;;
    --) args+=("$@"); break ;;
    *) args+=("$1"); shift ;;
  esac
done

case "$edition" in
  personal|team|all) ;;
  *) fail "--edition 仅支持 personal、team 或 all。" ;;
esac

if "$help"; then
  cat <<'HELP'
统一入口：./package-client.sh [--edition personal|team|all] <打包参数>
兼容入口：./apps/personal-client/package-client.sh，接受相同参数。

  --edition personal|team|all  personal 为个人版（默认），team 为团队版
                              all 依次打两版，任一失败即停止
  --version <SemVer>          默认读取所选客户端 package.json 的 version
  --arch arm64|x64            默认使用当前 Mac 架构
  --out <新目录>             单版直接使用；all 分别输出到 personal/ 和 team/
  --channel <渠道>           默认个人版 stable、团队版 stable-studio
  --security-epoch <非负整数> 默认 0，按既有发行策略指定
  --formal                   Developer ID 签名、Apple 公证、票据装订和校验
  --local                    本地验证包，不提交 Apple 公证；不能与 --formal 同用
  --notary-profile <配置名>   --formal 默认 WANX_NOTARY_PROFILE 或 WANX-NOTARY
  --trust-file <公钥JSON>     --formal 默认 ~/.config/wanx-release/wanx-client-trust.json
  --help                     显示帮助，无需先安装 Node.js 或项目依赖

不指定 --formal 时保留原行为；正式包仍需提供公证和发行公钥配置。
all 不支持共用 --channel；自定义渠道请分别打包。
相对 --out、--trust-file 等文件路径以调用时的工作目录为准。

隔离测试包需同时提供：
  --test --version <预发布版本> --test-run-id <小写标识>
  --test-feed-url https://127.0.0.1:<端口>/ --test-ca <证书PEM> --trust-file <测试公钥JSON>
测试包独立安装且不公证，不能与 --formal 或 --local 同用，不能发布到正式渠道。

首次使用先安装所选客户端、apps/builder 和 octop/dashboard 的 npm 依赖，详见 README.md。
本入口生成 macOS 客户端包；Windows 正式包使用对应客户端的 tools/package-client-windows.mjs。
发行清单签名工具为对应客户端的 tools/sign-client-release.mjs。
市场应用使用 apps/personal-client/package-app.sh；发布与更新流程见 docs/release/wanx-client-release-and-update-flow.md。
HELP
  exit 0
fi

if "$formal"; then
  if "$local_mode" || "$test_mode"; then
    fail "--formal 不能与 --local 或 --test 同用。"
  fi
  if ! "$has_notary_profile"; then
    defaults+=(--notary-profile "${WANX_NOTARY_PROFILE:-WANX-NOTARY}")
  fi
  if ! "$has_trust_file"; then
    defaults+=(--trust-file "$HOME/.config/wanx-release/wanx-client-trust.json")
  fi
fi

if [[ "$edition" == all ]] && "$has_channel"; then
  fail "--edition all 不能共用 --channel，请使用各版默认渠道或分别打包。"
fi

if [[ "$edition" != all ]]; then
  client_dir="$script_dir"
  if [[ "$edition" == team ]]; then client_dir="$script_dir/../team-client"; fi
  # Bash 3.2 needs this expansion for an empty array under set -u.
  exec node "$client_dir/tools/package-client.mjs" ${defaults[@]+"${defaults[@]}"} ${args[@]+"${args[@]}"}
fi

for target in personal team; do
  client_dir="$script_dir"
  if [[ "$target" == team ]]; then client_dir="$script_dir/../team-client"; fi
  target_args=(${args[@]+"${args[@]}"})
  if [[ "$out_index" -ge 0 ]]; then
    target_args[$out_index]="${out%/}/$target"
    if "$out_inline"; then target_args[$out_index]="--out=${out%/}/$target"; fi
  fi
  printf '开始打包：%s\n' "$target"
  node "$client_dir/tools/package-client.mjs" ${defaults[@]+"${defaults[@]}"} ${target_args[@]+"${target_args[@]}"}
done
