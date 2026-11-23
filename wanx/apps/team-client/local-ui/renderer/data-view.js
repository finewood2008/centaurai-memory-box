"use strict";
(() => {
  // ../builder/integration/team-client/starlink/material-contract.mjs
  var id = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  var digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  var revision = (v) => Number.isSafeInteger(v) && v > 0;
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
  function materialErrorText(error) {
    const d = materialDiagnostic(error);
    const label = { network: "\u7F51\u7EDC\u6216\u5BA2\u6237\u7AEF\u5165\u53E3\u5F02\u5E38", authorization: "\u767B\u5F55\u6216\u8BBF\u95EE\u6743\u9650\u4E0D\u8DB3", unavailable: "\u6750\u6599\u4E0D\u5B58\u5728\u6216\u63A5\u53E3\u7248\u672C\u4E0D\u517C\u5BB9", server: "\u670D\u52A1\u7AEF\u5904\u7406\u5F02\u5E38", business: "\u670D\u52A1\u7AEF\u62D2\u7EDD\u5F53\u524D\u64CD\u4F5C", structure: "\u54CD\u5E94\u7ED3\u6784\u6216\u6750\u6599\u7248\u672C\u4E0D\u5339\u914D" }[d.category];
    return `${label}\uFF08${d.httpStatus ? "HTTP " + d.httpStatus + "\uFF1B" : "\u672A\u53D6\u5F97 HTTP \u72B6\u6001\uFF1B"}${d.code}${d.requestId ? "\uFF1B" + (d.requestSource === "client" ? "\u5BA2\u6237\u7AEF\u8BF7\u6C42 " : "\u8BF7\u6C42 ") + d.requestId : ""}\uFF09`;
  }
  function unwrapMaterialResponse(result) {
    if (!result?.materialResponse) return result;
    const r = result.materialResponse;
    if (!r.ok) throw Object.assign(Error(r.error.code), r.error);
    return { ...r.value, _transport: r.diagnostics };
  }
  function assertWorkflow(w, documentId, versionId) {
    if (!w || w.document_id !== documentId || !(w.document_version_id === null || id(w.document_version_id)) || versionId && w.document_version_id !== versionId || !revision(w.workflow_revision) || !w.actions || !w.automatic_processing || ["edit_source", "prepare_automatic"].some((k) => typeof w.actions[k]?.allowed !== "boolean") || w.actions.prepare_automatic.allowed && !id(w.document_version_id)) invalid(w);
    return w;
  }
  function invalid(value) {
    throw Object.assign(Error("MATERIAL_RESPONSE_INVALID"), materialDiagnostic({ code: "MATERIAL_RESPONSE_INVALID", category: "structure" }, value?._transport));
  }
  function assertPreview(p, w, operationId) {
    if (!p || p.document_id !== w.document_id || p.operation_id !== operationId || p.target_mode !== "automatic" || !id(p.preview_id) || !digest(p.preview_digest) || p.workflow_revision !== w.workflow_revision || !Number.isFinite(Date.parse(p.expires_at)) || typeof p.can_confirm !== "boolean" || !Array.isArray(p.blockers) || p.blockers.some((b) => !b || typeof b.code !== "string" || typeof b.detail !== "string")) invalid(p);
    if (p.can_confirm && (p.snapshot?.document_version_id !== w.document_version_id || p.publication_policy !== "automatic" || !p.replacement || ["draft_count", "modified_draft_count", "candidate_result_count", "modified_candidate_result_count"].some((k) => !Number.isSafeInteger(p.replacement[k]) || p.replacement[k] < 0) || ["requires_acknowledgement", "replaces_manual_publication", "preserves_history"].some((k) => typeof p.replacement[k] !== "boolean") || p.replacement.requires_acknowledgement && !digest(p.replacement.acknowledgement_digest))) invalid(p);
    return p;
  }
  function materialRequest(action, input) {
    const fields = {
      "material-workflows": ["offset", "limit"],
      "material-workflow": [],
      "material-preview": ["operationId", "versionId", "workflowRevision"],
      "material-transition": ["operationId", "previewId", "previewDigest", "workflowRevision", "confirmed", "replacementAcknowledgement"],
      "material-transition-status": ["transitionId"]
    }[action];
    const fail = () => {
      throw Object.assign(Error("TEAM_DATA_TARGET_INVALID"), { code: "TEAM_DATA_TARGET_INVALID" });
    };
    if (!fields || !input || Array.isArray(input) || Object.keys(input).some((k) => !["warehouseId", ...action === "material-workflows" ? [] : ["documentId"], ...fields].includes(k)) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.warehouseId || "")) fail();
    const base = "/warehouses/" + input.warehouseId + "/workbench/conversations/materials";
    if (action === "material-workflows") {
      const offset = input.offset ?? 0, limit = input.limit ?? 50;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail();
      return { path: base + "?" + new URLSearchParams({ offset: String(offset), limit: String(limit) }) };
    }
    if (!id(input.documentId)) fail();
    const path = base + "/" + input.documentId;
    if (action === "material-workflow") return { path };
    if (action === "material-transition-status") {
      if (!id(input.transitionId)) fail();
      return { path: path + "/processing-transitions/" + input.transitionId };
    }
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.operationId || "") || !revision(input.workflowRevision)) fail();
    const body = { operation_id: input.operationId, _native_operation_id: input.operationId, expected_workflow_revision: input.workflowRevision };
    if (action === "material-preview") {
      if (!id(input.versionId)) fail();
      Object.assign(body, { target_mode: "automatic", expected_document_version_id: input.versionId });
    } else {
      if (!id(input.previewId) || !digest(input.previewDigest) || input.confirmed !== true || input.replacementAcknowledgement !== void 0 && !digest(input.replacementAcknowledgement)) fail();
      Object.assign(body, {
        preview_id: input.previewId,
        preview_digest: input.previewDigest,
        confirmed: true,
        ...input.replacementAcknowledgement !== void 0 ? { replacement_acknowledgement: input.replacementAcknowledgement } : {}
      });
    }
    return { path: path + (action === "material-preview" ? "/processing-previews" : "/processing-transitions"), options: { method: "POST", body } };
  }

  // ../builder/integration/team-client/assistant-knowledge-access.js
  var esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  async function openAssistantKnowledgeAccess({ warehouseId, request, isCurrent, message }) {
    const result = await request("data.assistant-access", { warehouseId });
    if (!isCurrent()) return;
    const d = document.createElement("dialog");
    d.className = "data-dialog assistant-access-dialog";
    d.dataset.teamDataDialog = "";
    d.setAttribute("aria-label", "\u52A9\u7406\u6388\u6743");
    d.innerHTML = "<header><div><h3>\u52A9\u7406\u6388\u6743</h3><p>" + esc(result.warehouse.name) + ' \xB7 \u4EC5\u6388\u6743\u77E5\u8BC6\u8BFB\u53D6</p></div><button type="button" data-close aria-label="\u5173\u95ED\u52A9\u7406\u6388\u6743">\xD7</button></header><form><label>\u53EF\u4F7F\u7528\u6210\u5458<select name="audience"><option value="none">\u6682\u4E0D\u6388\u6743\u6210\u5458</option><option value="all">\u5168\u90E8\u6210\u5458\uFF08\u542B\u540E\u7EED\u52A0\u5165\u7684\u6210\u5458\uFF09</option><option value="selected">\u6307\u5B9A\u6210\u5458</option></select></label><fieldset><legend>\u6307\u5B9A\u6210\u5458</legend>' + result.users.filter((m) => m.role !== "admin").map((m) => '<label><input type="checkbox" name="members" value="' + m.id + '"' + (result.members.includes(m.id) ? " checked" : "") + (m.disabled ? " disabled" : "") + "/>" + esc(m.name) + (m.disabled ? "\uFF08\u5DF2\u505C\u7528\uFF09" : "") + "</label>").join("") + '</fieldset><p>\u7BA1\u7406\u5458\u6309\u73B0\u6709\u6743\u9650\u4F7F\u7528\u3002\u6210\u5458\u53EA\u80FD\u5728\u52A9\u7406\u4E2D\u9009\u62E9\u5DF2\u6388\u6743\u4ED3\u5E93\uFF0C\u4E0D\u4F1A\u83B7\u5F97\u6570\u636E\u4ED3\u7BA1\u7406\u6743\u9650\u3002</p><p data-status role="status"></p><footer><button type="button" data-close>\u53D6\u6D88</button><button type="submit" class="button primary">\u4FDD\u5B58\u6388\u6743</button></footer></form>';
    document.body.append(d);
    const audience = d.querySelector("select");
    audience.value = result.audience;
    const update = () => {
      d.querySelector("fieldset").hidden = audience.value !== "selected";
    };
    update();
    audience.addEventListener("change", update);
    let busy = false;
    d.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => {
      if (!busy) d.close();
    });
    d.addEventListener("cancel", (e) => {
      if (busy) e.preventDefault();
    });
    d.addEventListener("close", () => d.remove(), { once: true });
    d.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !isCurrent()) return;
      const data = new FormData(event.target), members = data.getAll("members").map(Number), kind = data.get("audience");
      if (kind === "selected" && !members.length) {
        d.querySelector("[data-status]").textContent = "\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u540D\u6B63\u5E38\u6210\u5458\u3002";
        return;
      }
      busy = true;
      for (const b of d.querySelectorAll("button,input,select")) b.disabled = true;
      try {
        await request("data.assistant-access-update", { warehouseId, audience: kind, members, revision: result.revision });
        if (isCurrent()) d.close();
        else d.remove();
      } catch (e) {
        if (isCurrent()) d.querySelector("[data-status]").textContent = message(e);
      } finally {
        busy = false;
        for (const b of d.querySelectorAll("button,input,select")) b.disabled = false;
      }
    });
    d.showModal();
  }
  function wrapAssistantKnowledgeAccess(createOriginal) {
    return (options) => {
      const view = createOriginal(options);
      if (options.edition === "personal") return view;
      let revision2 = 0, context = null, admin = false;
      return {
        ...view,
        suspend() {
          revision2++;
          admin = false;
          return view.suspend();
        },
        sync(state, isAdmin, options2) {
          const next = JSON.stringify([state.account?.accountId, state.account?.clientId, state.activeDeviceId, isAdmin]);
          if (context !== next) {
            context = next;
            revision2++;
          }
          admin = isAdmin;
          return view.sync(state, isAdmin, options2);
        },
        render() {
          const html = view.render();
          if (!admin || html.includes('data-data-action="assistant-access"')) return html;
          return html.replace(/<button\b[^>]*data-data-action="share-create"[^>]*>/, (match) => {
            const id2 = match.match(/data-warehouse-id="([a-f0-9-]{36})"/)?.[1];
            return id2 ? '<button class="button" data-data-action="assistant-access" data-warehouse-id="' + id2 + '">\u52A9\u7406\u6388\u6743</button>' + match : match;
          });
        },
        async action(name, data) {
          if (name !== "assistant-access") {
            revision2++;
            return view.action(name, data);
          }
          if (!admin) return;
          const version = revision2;
          return openAssistantKnowledgeAccess({
            warehouseId: data.warehouseId,
            request: options.request,
            isCurrent: () => admin && revision2 === version,
            message: (e) => e.code === "ASSISTANT_KNOWLEDGE_CONFLICT" ? "\u6388\u6743\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5173\u95ED\u540E\u91CD\u65B0\u6253\u5F00\u3002" : e.code || e.message
          });
        }
      };
    };
  }

  // ../builder/integration/team-client/starlink/graph.mjs
  function graphVisibility(graph, showIsolated = false) {
    const ids = new Set(graph.nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.s) && ids.has(e.t));
    const connected = new Set(edges.flatMap((e) => [e.s, e.t]));
    const isolatedCount = graph.nodes.filter((n) => !connected.has(n.id)).length;
    return { nodes: showIsolated ? graph.nodes : graph.nodes.filter((n) => connected.has(n.id)), edges, isolatedCount };
  }
  function referenceNodes(graph) {
    const names = /* @__PURE__ */ new Set();
    for (const e of graph.edges) for (const v of e.evidence || [])
      for (const match of (v.excerpt || "").matchAll(/(?:^|[\s>*#-])([CJ]\d{2,3})[*\s]*[｜|]/gim))
        names.add(match[1].toUpperCase());
    return new Set(graph.nodes.filter((n) => names.has(n.name.toUpperCase())).map((n) => n.id));
  }
  function selectGraph(graph, { query = "", type = "all", overview = true, focus = null, members = null } = {}) {
    const references = referenceNodes(graph);
    const needle = query.trim().toLocaleLowerCase();
    let nodes = graph.nodes.filter((n) => (!members || members.has(n.id)) && (type === "all" || n.type === type) && (needle || !overview || !references.has(n.id) || n.id === focus));
    if (needle) {
      const matches = new Set(nodes.filter((n) => n.name.toLocaleLowerCase().includes(needle)).map((n) => n.id));
      const neighbors = new Set(matches);
      graph.edges.forEach((e) => {
        if (matches.has(e.s)) neighbors.add(e.t);
        if (matches.has(e.t)) neighbors.add(e.s);
      });
      nodes = nodes.filter((n) => neighbors.has(n.id));
    }
    if (focus) {
      const neighbors = /* @__PURE__ */ new Set([focus]);
      graph.edges.forEach((e) => {
        if (e.s === focus) neighbors.add(e.t);
        if (e.t === focus) neighbors.add(e.s);
      });
      nodes = nodes.filter((n) => neighbors.has(n.id));
    }
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.edges.filter((e) => ids.has(e.s) && ids.has(e.t) && (!focus || e.s === focus || e.t === focus)), referenceCount: references.size };
  }
  function describeConstellations(graph) {
    const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const metrics = new Map(nodes.map((n) => [n.id, { relations: 0, documents: /* @__PURE__ */ new Set() }]));
    const references = referenceNodes(graph);
    const groups = new Map(nodes.filter((n) => !references.has(n.id)).map((n) => [n.id, { members: [n], weight: 0, links: /* @__PURE__ */ new Map() }]));
    const paused = new Set(nodes.filter((n) => n.paused).map((n) => n.id));
    const seen = /* @__PURE__ */ new Set();
    let totalWeight = 0;
    for (const edge of graph.edges) {
      if (seen.has(edge.id) || edge.paused || paused.has(edge.s) || paused.has(edge.t) || !metrics.has(edge.s) || !metrics.has(edge.t)) continue;
      const documents = edge.evidence.map((e) => e?.document_id).filter(Boolean);
      if (!documents.length) continue;
      seen.add(edge.id);
      for (const id2 of /* @__PURE__ */ new Set([edge.s, edge.t])) {
        const metric = metrics.get(id2);
        metric.relations++;
        documents.forEach((doc) => metric.documents.add(doc));
      }
      if (edge.s === edge.t || !groups.has(edge.s) || !groups.has(edge.t)) continue;
      for (const [a, b] of [[edge.s, edge.t], [edge.t, edge.s]]) {
        const group = groups.get(a);
        group.links.set(b, (group.links.get(b) || 0) + 1);
        group.weight++;
      }
      totalWeight += 2;
    }
    for (; ; ) {
      let best = 0, merge;
      for (const [id2, group2] of groups) {
        for (const otherId of [...group2.links.keys()].sort()) {
          if (id2.localeCompare(otherId) >= 0) continue;
          const gain = group2.links.get(otherId) - group2.weight * groups.get(otherId).weight / totalWeight;
          if (gain > best + 1e-8) {
            best = gain;
            merge = [id2, otherId];
          }
        }
      }
      if (!merge) break;
      const [a, b] = merge;
      const group = groups.get(a), other = groups.get(b);
      group.members.push(...other.members);
      group.weight += other.weight;
      group.links.delete(b);
      for (const [id2, count] of other.links) {
        if (id2 === a) continue;
        const peer = groups.get(id2);
        const combined = (group.links.get(id2) || 0) + count;
        group.links.set(id2, combined);
        peer.links.delete(b);
        peer.links.set(a, combined);
      }
      groups.delete(b);
    }
    const constellations = [];
    const loose = [];
    for (const [id2, { members }] of groups) {
      if (members.length === 1) {
        loose.push(members[0].id);
        continue;
      }
      members.sort((a, b) => metrics.get(b.id).relations - metrics.get(a.id).relations || a.id.localeCompare(b.id));
      constellations.push({ id: "group-" + id2, name: members[0].name, members: new Set(members.map((n) => n.id)) });
    }
    constellations.sort((a, b) => b.members.size - a.members.size || a.id.localeCompare(b.id));
    const names = /* @__PURE__ */ new Map();
    for (const group of constellations) {
      const number = (names.get(group.name) || 0) + 1;
      names.set(group.name, number);
      if (number > 1) group.name += " " + number;
    }
    if (loose.length && constellations.length) constellations.push({ id: "ungrouped", name: "\u672A\u5F52\u7EC4\u5B9E\u4F53", members: new Set(loose) });
    const membership = new Map(constellations.flatMap((group) => [...group.members].map((id2) => [id2, group.id])));
    const counts = new Map([...metrics].map(([id2, value]) => [id2, { relations: value.relations, sources: value.documents.size }]));
    const maxima = {
      relations: Math.max(1, ...[...counts.values()].map((m) => m.relations)),
      sources: Math.max(1, ...[...counts.values()].map((m) => m.sources))
    };
    return { constellations, membership, counts, maxima };
  }
  function layoutConstellations(graph, constellations) {
    if (constellations.length < 2) return layoutGraph(graph);
    const islands = constellations.map((group) => {
      const layout = layoutGraph({
        nodes: graph.nodes.filter((n) => group.members.has(n.id)),
        edges: graph.edges.filter((e) => group.members.has(e.s) && group.members.has(e.t))
      });
      const left = Math.min(...layout.nodes.map((n) => n.x - Math.max(n.labelWidth / 2, n.r)));
      const top = Math.min(...layout.nodes.map((n) => n.y - n.r));
      const width = Math.max(140, Math.max(...layout.nodes.map((n) => n.x + Math.max(n.labelWidth / 2, n.r))) - left + 24);
      const height = Math.max(104, Math.max(...layout.nodes.map((n) => n.y + n.r + n.lines.length * 15)) - top + 70);
      return { group, nodes: layout.nodes, left, top, width, height };
    });
    const rowWidth = Math.max(...islands.map((g) => g.width), Math.sqrt(islands.reduce((sum, g) => sum + g.width * g.height, 0) * 2.4));
    let x = 0, y = 0, rowHeight = 0;
    const anchors = [];
    const nodes = [];
    for (const island of islands) {
      if (x && x + island.width > rowWidth) {
        x = 0;
        y += rowHeight + 26;
        rowHeight = 0;
      }
      const { group, left, top, width, height } = island;
      anchors.push({ ...group, x: x + width / 2, y: y + 3, z: 0 });
      nodes.push(...island.nodes.map((n) => ({ ...n, x: n.x - left + x + 12, y: n.y - top + y + 36, constellation: group.id })));
      x += width + 58;
      rowHeight = Math.max(rowHeight, height);
    }
    return { ...graph, nodes: nodes.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)), anchors };
  }
  function labelLines(name) {
    const lines = [""];
    let width = 0;
    for (const char of String(name)) {
      const size = /[\u0000-\u007f]/.test(char) ? 0.6 : 1;
      if (width + size > 10) {
        if (lines.length === 2) {
          lines[1] += "\u2026";
          break;
        }
        lines.push("");
        width = 0;
      }
      lines[lines.length - 1] += char;
      width += size;
    }
    return lines;
  }
  function layoutGraph(graph) {
    const degree = new Map(graph.nodes.map((n) => [n.id, 0]));
    graph.edges.forEach((e) => {
      if (e.s !== e.t) {
        degree.set(e.s, (degree.get(e.s) || 0) + 1);
        degree.set(e.t, (degree.get(e.t) || 0) + 1);
      }
    });
    const nodes = graph.nodes.map((n) => ({ ...n, degree: degree.get(n.id), lines: labelLines(n.name) })).sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
    nodes.forEach((n, i) => {
      n.r = Math.min(29, 19 + Math.sqrt(n.degree) * 1.7);
      n.x = 400 + Math.sqrt(i) * 94 * Math.cos(i * 2.39996);
      n.y = 270 + Math.sqrt(i) * 55 * Math.sin(i * 2.39996);
      n.labelWidth = Math.max(...n.lines.map((l) => [...l].reduce((w, c) => w + (/[\u0000-\u007f]/.test(c) ? 7.2 : 12), 0)));
    });
    const ids = new Map(nodes.map((n) => [n.id, n]));
    const edges = graph.edges.filter((e) => ids.has(e.s) && ids.has(e.t));
    for (let k = 0; k < 360; k++) {
      const forces = new Map(nodes.map((n) => [n.id, { x: (400 - n.x) * 1e-3, y: (270 - n.y) * 9e-3 }]));
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j], dx = a.x - b.x || 0.01, dy = a.y - b.y || 0.01;
        const d = Math.max(1, Math.hypot(dx, dy)), repulsion = 3e3 / (d * d);
        let fx = dx / d * repulsion, fy = dy / d * repulsion;
        const ox = Math.max(a.r + 9, a.labelWidth / 2) + Math.max(b.r + 9, b.labelWidth / 2) + 16 - Math.abs(dx);
        const oy = a.r + b.r + 30 + 8 * Math.max(a.lines.length, b.lines.length) - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) fx += Math.sign(dx) * ox * 0.35;
          else fy += Math.sign(dy) * oy * 0.35;
        }
        forces.get(a.id).x += fx;
        forces.get(a.id).y += fy;
        forces.get(b.id).x -= fx;
        forces.get(b.id).y -= fy;
      }
      edges.forEach((e) => {
        if (e.s === e.t) return;
        const a = ids.get(e.s), b = ids.get(e.t), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const f = (d - 165) * 0.025;
        forces.get(a.id).x += dx / d * f;
        forces.get(a.id).y += dy / d * f;
        forces.get(b.id).x -= dx / d * f;
        forces.get(b.id).y -= dy / d * f;
      });
      const step = 0.8 * (1 - k / 480);
      nodes.forEach((n) => {
        const f = forces.get(n.id);
        n.x += Math.max(-9, Math.min(9, f.x)) * step;
        n.y += Math.max(-9, Math.min(9, f.y)) * step;
      });
    }
    return { ...graph, nodes, edges };
  }
  function edgeGeometry(a, b, index = 0, count = 1) {
    if (a.id === b.id) {
      const r = a.r + 24 + index * 18;
      return { d: `M${a.x - a.r * 0.7} ${a.y - a.r * 0.7}C${a.x - r * 2} ${a.y - r * 2} ${a.x + r * 2} ${a.y - r * 2} ${a.x + a.r * 0.7} ${a.y - a.r * 0.7}`, x: a.x, y: a.y - r * 1.5, angle: 0 };
    }
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const bend = (index - (count - 1) / 2) * 32 * (a.id < b.id ? 1 : -1);
    const cx = (a.x + b.x) / 2 - dy / d * bend, cy = (a.y + b.y) / 2 + dx / d * bend;
    const start = Math.hypot(cx - a.x, cy - a.y) || 1, end = Math.hypot(b.x - cx, b.y - cy) || 1;
    const sx = a.x + (cx - a.x) / start * (a.r + 3), sy = a.y + (cy - a.y) / start * (a.r + 3);
    const tx = b.x - (b.x - cx) / end * (b.r + 6), ty = b.y - (b.y - cy) / end * (b.r + 6);
    let angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    return { d: `M${sx} ${sy}Q${cx} ${cy} ${tx} ${ty}`, x: (sx + 2 * cx + tx) / 4, y: (sy + 2 * cy + ty) / 4, angle };
  }

  // ../builder/integration/team-client/starlink/motion.mjs
  var SVG_NS = "http://www.w3.org/2000/svg";
  var DEFAULT_YAW = 0.24;
  var DEFAULT_PITCH = -0.18;
  var clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function stepForces(nodes, edges, held = null, heat = 1) {
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const forces = nodes.map((node) => ({
      x: (node.homeX - node.x) * 2e-3,
      y: (node.homeY - node.y) * 2e-3,
      z: ((node.homeZ ?? 0) - (node.z ?? 0)) * 2e-3
    }));
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x || 0.01;
        const dy = b.y - a.y || 0.01;
        const dz = (b.z ?? 0) - (a.z ?? 0);
        const distance = Math.max(1, Math.hypot(dx, dy, dz));
        const repel = 2200 / distance ** 3;
        let fx = dx * repel;
        let fy = dy * repel;
        const overlap = Math.max(a.r + 12, a.labelWidth / 2) + Math.max(b.r + 12, b.labelWidth / 2) + 12 - Math.abs(dx);
        const vertical = a.r + b.r + 42 - Math.abs(dy);
        if (overlap > 0 && vertical > 0 && Math.abs(dz) < a.r + b.r + 26) {
          if (overlap < vertical) fx += Math.sign(dx) * overlap * 0.08;
          else fy += Math.sign(dy) * vertical * 0.08;
        }
        forces[i].x -= fx;
        forces[i].y -= fy;
        forces[i].z -= dz * repel;
        forces[j].x += fx;
        forces[j].y += fy;
        forces[j].z += dz * repel;
      }
    }
    for (const edge of edges) {
      const i = index.get(edge.s);
      const j = index.get(edge.t);
      if (i === void 0 || j === void 0 || i === j) continue;
      const a = nodes[i];
      const b = nodes[j];
      if (a.constellation !== b.constellation) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = (b.z ?? 0) - (a.z ?? 0);
      const distance = Math.hypot(dx, dy, dz) || 1;
      const spring = (distance - 165) * 0.018 / distance;
      forces[i].x += dx * spring;
      forces[i].y += dy * spring;
      forces[i].z += dz * spring;
      forces[j].x -= dx * spring;
      forces[j].y -= dy * spring;
      forces[j].z -= dz * spring;
    }
    nodes.forEach((node, i) => {
      if (node.id === held) {
        node.vx = node.vy = node.vz = 0;
        return;
      }
      const force = forces[i];
      node.vx = ((node.vx || 0) + force.x * heat) * 0.76;
      node.vy = ((node.vy || 0) + force.y * heat) * 0.76;
      node.vz = ((node.vz || 0) + force.z * heat) * 0.76;
      node.x += clamp(node.vx, -8, 8);
      node.y += clamp(node.vy, -8, 8);
      node.z = (node.z ?? 0) + clamp(node.vz, -8, 8);
    });
  }
  function bounds(points) {
    return {
      left: Math.min(...points.map((point) => point.x)),
      right: Math.max(...points.map((point) => point.x)),
      top: Math.min(...points.map((point) => point.y)),
      bottom: Math.max(...points.map((point) => point.y)),
      back: Math.min(...points.map((point) => point.z)),
      front: Math.max(...points.map((point) => point.z))
    };
  }
  function orientation(yaw, pitch) {
    return { cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch) };
  }
  function project(point, center, rotation, distance) {
    const x = point.x - center.x;
    const y = point.y - center.y;
    const z = point.z - center.z;
    const { cy, sy, cp, sp } = rotation;
    const horizontalDepth = z * cy - x * sy;
    const depth = horizontalDepth * cp + y * sp;
    const perspective = distance / Math.max(distance * 0.48, distance - depth);
    return {
      x: (x * cy + z * sy) * perspective,
      y: (y * cp - horizontalDepth * sp) * perspective,
      z: depth,
      perspective
    };
  }
  function createGraphMotion() {
    let pending = 0;
    let frame = 0;
    let state = null;
    let key = null;
    const positions = /* @__PURE__ */ new Map();
    const raf = (fn) => globalThis.requestAnimationFrame(fn);
    const cancel = (id2) => {
      if (id2) globalThis.cancelAnimationFrame?.(id2);
    };
    function detach() {
      cancel(frame);
      frame = 0;
      if (!state) return;
      state.abort.abort();
      state.resize?.disconnect();
      const pointer = state.pointer;
      state.pointer = null;
      if (pointer && pointer.capture.hasPointerCapture(pointer.id)) {
        pointer.capture.releasePointerCapture(pointer.id);
      }
    }
    function reset() {
      cancel(pending);
      pending = 0;
      detach();
      state = null;
      key = null;
      positions.clear();
    }
    function reframe(scene, recenter = false) {
      const { svg, nodes, camera } = scene;
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (!width || !height || !nodes.length) return;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      if (recenter) {
        const region = bounds(nodes);
        scene.center = {
          x: (region.left + region.right) / 2,
          y: (region.top + region.bottom) / 2,
          z: (region.back + region.front) / 2
        };
        const radius = Math.max(...nodes.map((node) => Math.hypot(node.x - scene.center.x, node.y - scene.center.y, node.z - scene.center.z)));
        scene.distance = Math.max(440, radius * 3.2);
        scene.region = region;
      }
      scene.rotation = orientation(camera.yaw, camera.pitch);
      const projected = bounds(nodes.map((node) => project(node, scene.center, scene.rotation, scene.distance)));
      const scale = Math.min(
        1.12,
        Math.max(100, width - Math.min(110, width * 0.24)) / (projected.right - projected.left + 58),
        Math.max(90, height - 94) / (projected.bottom - projected.top + 52)
      );
      scene.viewport = {
        width,
        height,
        scale,
        x: width / 2 - (projected.left + projected.right) * scale / 2,
        y: (height - 38) / 2 - (projected.top + projected.bottom) * scale / 2
      };
    }
    function screenPoint(scene, point) {
      const projected = project(point, scene.center, scene.rotation, scene.distance);
      const { viewport, camera } = scene;
      return {
        ...projected,
        x: viewport.x + camera.panX + projected.x * viewport.scale * camera.zoom,
        y: viewport.y + camera.panY + projected.y * viewport.scale * camera.zoom
      };
    }
    function paintFloor(scene) {
      const { region, floor } = scene;
      if (!floor.length) return;
      const xPad = Math.max(76, (region.right - region.left) * 0.15);
      const zPad = Math.max(86, (region.front - region.back) * 0.23);
      const left = region.left - xPad;
      const right = region.right + xPad;
      const back = region.back - zPad;
      const front = region.front + zPad;
      const y = region.bottom + 58;
      floor.forEach((line, i) => {
        const across = i < 9;
        const t = i % 9 / 8;
        const x = left + (right - left) * t;
        const z = back + (front - back) * t;
        const a = screenPoint(scene, across ? { x, y, z: back } : { x: left, y, z });
        const b = screenPoint(scene, across ? { x, y, z: front } : { x: right, y, z });
        line.setAttribute("x1", a.x);
        line.setAttribute("y1", a.y);
        line.setAttribute("x2", b.x);
        line.setAttribute("y2", b.y);
      });
    }
    function paint(scene) {
      if (!scene.viewport) return;
      const { nodes, graph, viewport, camera, sizeBy } = scene;
      const points = /* @__PURE__ */ new Map();
      for (const node of nodes) {
        const point = screenPoint(scene, node);
        const value = sizeBy.counts.get(node.id)?.[sizeBy.metric] ?? 0;
        point.r = Math.sqrt(12 + 110 * value / sizeBy.max) * clamp(viewport.width / 650, 0.7, 1) * camera.zoom;
        points.set(node.id, point);
      }
      scene.points = points;
      paintFloor(scene);
      const labels = [];
      const namedGroups = /* @__PURE__ */ new Set();
      const starBoxes = [...points.values()].map((star) => ({
        left: star.x - star.r - 2,
        right: star.x + star.r + 2,
        top: star.y - star.r - 2,
        bottom: star.y + star.r + 2
      }));
      const fits = (box) => box.left >= 5 && box.right <= viewport.width - 5 && box.top >= 5 && box.bottom <= viewport.height - 52;
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const available = (box) => fits(box) && !labels.some((label) => overlaps(box, label)) && !starBoxes.some((star) => overlaps(box, star));
      for (const anchor of graph.anchors || []) {
        const { x, y } = screenPoint(scene, anchor);
        const { element, width } = scene.anchors.get(anchor.id);
        const half = width / 2 + 4;
        const cx = clamp(x, half, viewport.width - half);
        const cy = clamp(y, 19, viewport.height - 67);
        const box = [cy, cy - 26, cy - 52, cy + 26, cy + 52].map((center) => ({
          left: cx - half,
          right: cx + half,
          top: center - 14,
          bottom: center + 14,
          center
        })).find(available);
        element.setAttribute("visibility", box ? "visible" : "hidden");
        if (box) {
          element.setAttribute("transform", `translate(${cx} ${box.center})`);
          labels.push(box);
          namedGroups.add(anchor.id);
        }
      }
      const relations = [];
      for (const edge of graph.edges) {
        const element = scene.edges.get(edge.id);
        if (!element) continue;
        const a = points.get(edge.s);
        const b = points.get(edge.t);
        const group = scene.groups.get(JSON.stringify([edge.s, edge.t].sort()));
        const path = edgeGeometry({ id: edge.s, ...a }, { id: edge.t, ...b }, group.indexOf(edge.id), group.length);
        element.querySelectorAll("path").forEach((el) => el.setAttribute("d", path.d));
        const label = scene.relationLabels.get(edge.id);
        if (label) relations.push({ ...label, x: path.x, y: path.y, chosen: element.classList.contains("chosen") });
      }
      const shownPerGroup = /* @__PURE__ */ new Map();
      const limit = !graph.anchors || camera.zoom >= 1.8 ? Infinity : camera.zoom >= 1.25 ? 6 : camera.zoom >= 0.8 ? 3 : 1;
      for (const node of scene.ranked) {
        const element = scene.elements.get(node.id);
        if (!element) continue;
        const { x, y, r } = points.get(node.id);
        element.setAttribute("transform", `translate(${x} ${y})`);
        element.querySelector(".node-star").setAttribute("r", r);
        element.querySelector(".node-star-glow").setAttribute("r", r * 2.05);
        element.querySelector(".node-star-hit").setAttribute("r", Math.max(11, r + 3));
        const name = element.querySelector(".node-name");
        const half = node.labelWidth / 2 + 4;
        const extraLine = (node.lines.length - 1) * 15;
        const sameAsGroup = namedGroups.has(node.constellation) && scene.anchors.get(node.constellation).name === node.name;
        const count = shownPerGroup.get(node.constellation) || 0;
        const candidates = [[0, r + 15], [0, -r - 7 - extraLine], [r + half + 5, 5 - extraLine / 2], [-r - half - 5, 5 - extraLine / 2]].map(([dx, dy]) => ({
          left: x + dx - half,
          right: x + dx + half,
          top: y + dy - 12,
          bottom: y + dy + 5 + extraLine,
          dx,
          dy
        }));
        let box = count < limit && !sameAsGroup ? candidates.find(available) : null;
        if (!box && node.id === scene.selected) box = candidates.find(fits);
        name.setAttribute("y", box?.dy ?? r + 15);
        name.setAttribute("transform", `translate(${box?.dx ?? 0} 0)`);
        element.classList.toggle("is-label-hidden", !box);
        element.classList.toggle("has-group-name", sameAsGroup);
        if (box) {
          labels.push(box);
          shownPerGroup.set(node.constellation, count + 1);
        }
      }
      for (const relation of relations.sort((a, b) => Number(b.chosen) - Number(a.chosen))) {
        const { element, x, y, width, chosen } = relation;
        const candidates = [y, y + 21].map((baseline) => ({
          left: x - width / 2 - 4,
          right: x + width / 2 + 4,
          top: baseline - 19,
          bottom: baseline - 3,
          baseline
        }));
        const box = candidates.find(available) || chosen && candidates.find(fits);
        element.setAttribute("visibility", box ? "visible" : "hidden");
        if (box) {
          element.setAttribute("transform", `translate(${x} ${box.baseline})`);
          labels.push(box);
        }
      }
      if (!scene.pointer?.node) {
        const depthOrder = [...nodes].sort((a, b) => points.get(a.id).z - points.get(b.id).z).map((node) => node.id);
        if (depthOrder.some((id2, i) => scene.depthOrder[i] !== id2)) {
          const focused = document.activeElement;
          const restoreFocus = scene.nodeLayer.contains(focused);
          for (const id2 of depthOrder) scene.nodeLayer.append(scene.elements.get(id2));
          scene.depthOrder = depthOrder;
          if (restoreFocus) focused.focus({ preventScroll: true });
        }
      }
      const output = scene.svg.parentElement.querySelector(".data-core-tools output");
      if (output) output.textContent = Math.round(camera.zoom * 100) + "%";
    }
    function wake(scene) {
      scene.heat = 1;
      if (frame) return;
      const tick = () => {
        frame = 0;
        if (state !== scene || !scene.svg.isConnected || document.hidden) return;
        stepForces(scene.nodes, scene.graph.edges, scene.pointer?.node?.id, scene.heat);
        paint(scene);
        scene.heat *= 0.91;
        if (scene.pointer?.node || scene.heat > 0.015) frame = raf(tick);
      };
      frame = raf(tick);
    }
    function zoomAt(scene, factor, x, y) {
      const { camera, viewport } = scene;
      if (!viewport) return false;
      const next = clamp(camera.zoom * factor, 0.25, 4);
      const ratio = next / camera.zoom;
      camera.panX = x - viewport.x + (viewport.x + camera.panX - x) * ratio;
      camera.panY = y - viewport.y + (viewport.y + camera.panY - y) * ratio;
      camera.zoom = next;
      paint(scene);
      return true;
    }
    function zoom(factor) {
      if (!state?.svg.isConnected || !state.viewport) return false;
      return zoomAt(state, factor, state.viewport.width / 2, state.viewport.height / 2);
    }
    function fit() {
      if (!state?.svg.isConnected || !state.nodes.length) return false;
      Object.assign(state.camera, { zoom: 1, panX: 0, panY: 0 });
      reframe(state, true);
      paint(state);
      return true;
    }
    function rotate(delta) {
      if (!state?.svg.isConnected || !state.nodes.length) return;
      state.camera.yaw += delta;
      state.rotation = orientation(state.camera.yaw, state.camera.pitch);
      paint(state);
    }
    function mount(svg, graph, sizeBy) {
      if (state?.svg === svg && state.graph === graph) {
        state.sizeBy = sizeBy;
        paint(state);
        return;
      }
      const previous = state;
      detach();
      if (previous?.graph !== graph) positions.clear();
      const initial = { yaw: previous?.camera.yaw ?? DEFAULT_YAW, pitch: previous?.camera.pitch ?? DEFAULT_PITCH, zoom: 1, panX: 0, panY: 0 };
      const nodes = graph.nodes.map((node, i) => {
        if (!positions.has(node.id)) {
          const z = Math.sin(i * 2.39996) * clamp(76 + graph.nodes.length * 2.7, 80, 232);
          positions.set(node.id, { ...node, z, homeX: node.x, homeY: node.y, homeZ: z });
        }
        return Object.assign(positions.get(node.id), { r: node.r, labelWidth: node.labelWidth, lines: node.lines });
      });
      const nodeLayer = svg.querySelector(".data-space-nodes");
      const elements = new Map([...nodeLayer.querySelectorAll(".data-core-node")].map((el) => [el.dataset.id, el]));
      const edges = new Map([...svg.querySelectorAll(".data-edge-hit")].map((el) => [el.dataset.id, el.parentElement]));
      const groups = /* @__PURE__ */ new Map();
      for (const edge of graph.edges) {
        const pair = JSON.stringify([edge.s, edge.t].sort());
        if (!groups.has(pair)) groups.set(pair, []);
        groups.get(pair).push(edge.id);
      }
      const floorLayer = svg.querySelector(".data-space-floor");
      const floor = nodes.length > 1 ? Array.from({ length: 18 }, () => document.createElementNS(SVG_NS, "line")) : [];
      floorLayer.replaceChildren(...floor);
      const anchors = new Map([...svg.querySelectorAll(".data-space-constellation")].map((element) => {
        const rect = element.querySelector("rect");
        const width = Math.ceil(element.querySelector("text").getComputedTextLength()) + 18;
        rect.setAttribute("x", -width / 2);
        rect.setAttribute("width", width);
        return [element.dataset.id, { element, width, name: graph.anchors.find((anchor) => anchor.id === element.dataset.id).name }];
      }));
      const relationLabels = /* @__PURE__ */ new Map();
      for (const [id2, edge] of edges) {
        const element = edge.querySelector("text");
        if (element) relationLabels.set(id2, { element, width: Math.ceil(element.getComputedTextLength()) });
      }
      const selected = nodeLayer.querySelector(".selected")?.dataset.id;
      const ranked = [...nodes].sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || (sizeBy.counts.get(b.id)?.relations ?? 0) - (sizeBy.counts.get(a.id)?.relations ?? 0) || b.degree - a.degree);
      const scene = state = {
        svg,
        graph,
        nodes,
        nodeLayer,
        elements,
        edges,
        groups,
        floor,
        sizeBy,
        depthOrder: [],
        anchors,
        relationLabels,
        ranked,
        byId: new Map(nodes.map((node) => [node.id, node])),
        selected,
        camera: previous?.graph === graph ? previous.camera : initial,
        abort: new AbortController(),
        pointer: null,
        suppress: false,
        heat: 0
      };
      if (!nodes.length) return;
      const listen = (type, fn, extra = {}) => svg.addEventListener(type, fn, { signal: scene.abort.signal, ...extra });
      reframe(scene, true);
      paint(scene);
      if (typeof ResizeObserver === "function") {
        scene.resize = new ResizeObserver(() => {
          reframe(scene);
          paint(scene);
        });
        scene.resize.observe(svg);
      }
      listen("pointerdown", (event) => {
        if (event.button !== 0 || scene.pointer || !scene.viewport) return;
        const target = event.target.closest(".data-core-node");
        const node = target ? scene.byId.get(target.dataset.id) : null;
        const capture = event.target.closest("[data-data-action]") || svg;
        scene.suppress = false;
        scene.pointer = {
          id: event.pointerId,
          node,
          capture,
          x: event.clientX,
          y: event.clientY,
          origin: node && { x: node.x, y: node.y, z: node.z },
          dragScale: node && scene.points.get(node.id).perspective * scene.viewport.scale * scene.camera.zoom,
          camera: { ...scene.camera },
          pan: event.shiftKey,
          moved: false
        };
        capture.setPointerCapture(event.pointerId);
      });
      listen("pointermove", (event) => {
        const pointer = scene.pointer;
        if (!pointer || pointer.id !== event.pointerId) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        if (!pointer.moved && Math.hypot(dx, dy) < 4) return;
        pointer.moved = true;
        event.preventDefault();
        svg.classList.add("is-dragging");
        if (pointer.node) {
          const { cy, sy, cp, sp } = scene.rotation;
          const x = dx / pointer.dragScale;
          const y = dy / pointer.dragScale;
          pointer.node.x = pointer.origin.x + x * cy + y * sp * sy;
          pointer.node.y = pointer.origin.y + y * cp;
          pointer.node.z = pointer.origin.z + x * sy - y * sp * cy;
          if (!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) wake(scene);
        } else if (pointer.pan) {
          scene.camera.panX = pointer.camera.panX + dx;
          scene.camera.panY = pointer.camera.panY + dy;
        } else {
          scene.camera.yaw = pointer.camera.yaw + dx * 7e-3;
          scene.camera.pitch = clamp(pointer.camera.pitch + dy * 6e-3, -0.66, 0.66);
          scene.rotation = orientation(scene.camera.yaw, scene.camera.pitch);
        }
        paint(scene);
      });
      const end = (event) => {
        const pointer = scene.pointer;
        if (!pointer || pointer.id !== event.pointerId) return;
        scene.pointer = null;
        scene.suppress = pointer.moved;
        svg.classList.remove("is-dragging");
        if (pointer.capture.hasPointerCapture(pointer.id)) pointer.capture.releasePointerCapture(pointer.id);
        if (pointer.moved) paint(scene);
      };
      listen("pointerup", end);
      listen("pointercancel", end);
      listen("lostpointercapture", end);
      listen("click", (event) => {
        if (!scene.suppress || event.detail === 0) return;
        scene.suppress = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true });
      listen("wheel", (event) => {
        event.preventDefault();
        if (scene.pointer) return;
        const rect = svg.getBoundingClientRect();
        zoomAt(scene, Math.exp(-clamp(event.deltaY, -100, 100) * 3e-3), event.clientX - rect.x, event.clientY - rect.y);
      }, { passive: false });
      let hovered;
      const highlight = (id2) => {
        if (hovered === id2) return;
        hovered = id2;
        const adjacent = /* @__PURE__ */ new Set([id2]);
        for (const edge of graph.edges) {
          if (edge.s === id2) adjacent.add(edge.t);
          if (edge.t === id2) adjacent.add(edge.s);
          edges.get(edge.id)?.classList.toggle("is-neighbor", edge.s === id2 || edge.t === id2);
        }
        svg.classList.toggle("has-hover", Boolean(id2));
        elements.forEach((el, nodeId) => el.classList.toggle("is-neighbor", adjacent.has(nodeId)));
      };
      listen("pointerover", (event) => highlight(event.target.closest(".data-core-node")?.dataset.id));
      listen("pointerleave", () => highlight(null));
    }
    function schedule(graph, nextKey, sizeBy) {
      if (typeof globalThis.requestAnimationFrame !== "function") return;
      if (key !== nextKey) {
        reset();
        key = nextKey;
      }
      cancel(pending);
      pending = raf(() => {
        pending = 0;
        const svg = document.querySelector(".data-lite-page .data-core-canvas svg.data-graph");
        if (svg) mount(svg, graph, sizeBy);
      });
    }
    return { schedule, reset, zoom, fit, rotate };
  }

  // ../builder/integration/team-client/starlink/material-automatic.mjs
  var esc2 = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  var terminal = /* @__PURE__ */ new Set(["published", "failed", "cancelled", "stale", "awaiting_review"]);
  var stages = { queued: "\u7B49\u5F85\u81EA\u52A8\u5904\u7406", running: "\u6B63\u5728\u62BD\u53D6\u548C\u6821\u9A8C", publishing: "\u6B63\u5728\u53D1\u5E03", published: "\u672C\u8F6E\u7ED3\u679C\u5DF2\u53D1\u5E03", failed: "\u81EA\u52A8\u5904\u7406\u5931\u8D25\uFF0C\u539F\u53D1\u5E03\u7ED3\u679C\u4FDD\u7559", cancelled: "\u81EA\u52A8\u5904\u7406\u5DF2\u53D6\u6D88\uFF0C\u539F\u53D1\u5E03\u7ED3\u679C\u4FDD\u7559", stale: "\u672C\u8F6E\u5904\u7406\u5DF2\u5931\u6548\uFF0C\u8BF7\u8BFB\u53D6\u5F53\u524D\u6750\u6599\u72B6\u6001", awaiting_review: "\u8FD9\u662F\u65E7\u7B56\u7565\u4EFB\u52A1\uFF0C\u4ECD\u9700\u6309\u539F\u6D41\u7A0B\u6838\u5BF9" };
  function createMaterialAutomatic({ call, changed, getContext, onDenied = () => {
  }, getStorage = () => globalThis.localStorage, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let state = null, generation = 0, timer;
    const contextKey = () => JSON.stringify(getContext());
    const journalKey = (documentId) => {
      const c = getContext();
      if (!c.recoveryScope) throw Object.assign(Error("MATERIAL_RECOVERY_UNAVAILABLE"), { code: "MATERIAL_RECOVERY_UNAVAILABLE" });
      return "wanx.material-automatic:" + JSON.stringify([c.recoveryScope, c.warehouseId, documentId]);
    };
    function storage() {
      const s = getStorage();
      if (!s) throw Error("MATERIAL_RECOVERY_UNAVAILABLE");
      return s;
    }
    function read(documentId) {
      try {
        const v = JSON.parse(storage().getItem(journalKey(documentId)) || "null");
        if (v) {
          materialRequest("material-transition", v.input);
          if (v.input.documentId !== documentId || v.input.warehouseId !== getContext().warehouseId) throw Error();
        }
        return v;
      } catch {
        throw Object.assign(Error("MATERIAL_RECOVERY_UNAVAILABLE"), { code: "MATERIAL_RECOVERY_UNAVAILABLE" });
      }
    }
    function write(value) {
      try {
        storage().setItem(journalKey(state.documentId), JSON.stringify(value));
      } catch {
        throw Object.assign(Error("MATERIAL_RECOVERY_UNAVAILABLE"), { code: "MATERIAL_RECOVERY_UNAVAILABLE" });
      }
    }
    function clear() {
      storage().removeItem(journalKey(state.documentId));
    }
    function reset() {
      generation++;
      clearTimer(timer);
      timer = null;
      state = null;
    }
    function live(s, g, c) {
      return state === s && generation === g && contextKey() === c;
    }
    async function run(fn) {
      if (!state || state.busy) return;
      const s = state, g = generation, c = contextKey();
      s.busy = true;
      s.error = "";
      changed();
      const current = () => live(s, g, c);
      try {
        await fn(s, current);
      } catch (e) {
        if (current()) {
          s.error = materialErrorText(e);
          if (e.code === "MATERIAL_RECOVERY_UNAVAILABLE") s.error = "\u65E0\u6CD5\u4FDD\u5B58\u6216\u8BFB\u53D6\u6062\u590D\u8BB0\u5F55\uFF0C\u8BF7\u68C0\u67E5\u672C\u5730\u5B58\u50A8\uFF1B\u672A\u53D1\u9001\u65B0\u7684\u786E\u8BA4\u8BF7\u6C42\u3002";
          if (/MATERIAL_PROCESSING_PREVIEW_(STALE|EXPIRED)$/.test(e.code || "")) {
            clear();
            s.pending = null;
            s.preview = null;
            s.needsPreview = true;
            s.error = "\u6750\u6599\u3001\u6A21\u578B\u6216\u5904\u7406\u914D\u7F6E\u5DF2\u53D8\u5316\uFF0C\u6216\u9884\u89C8\u5DF2\u8FC7\u671F\u3002\u8BF7\u91CD\u65B0\u9884\u89C8\u5E76\u786E\u8BA4\u3002";
          }
          if (e.httpStatus === 401 || e.httpStatus === 403 || e.httpStatus === 404 || /FORBIDDEN|SESSION|OWNER_REQUIRED|RESOURCE_NOT_FOUND/.test(e.code || "")) {
            s.preview = null;
            s.receipt = null;
            s.progress = null;
            s.denied = true;
            onDenied(s.documentId, e);
          }
        }
      } finally {
        if (current()) {
          s.busy = false;
          changed();
        }
      }
    }
    function validateReceipt(result, s) {
      const r = result?.receipt;
      if (!r || r.document_id !== s.documentId || r.target_mode !== "automatic" || typeof r.transition_id !== "string" || !r.transition_id || s.pending && (r.operation_id !== s.pending.operationId || r.preview_id !== s.pending.previewId) || s.receipt && r.transition_id !== s.receipt.transition_id) invalid(result);
      return r;
    }
    async function poll(s, current) {
      const value = await call("material-transition-status", { warehouseId: getContext().warehouseId, documentId: s.documentId, transitionId: s.receipt.transition_id });
      if (!current()) return;
      const receipt = validateReceipt(value, s), p = value.current;
      if (!p || !Object.hasOwn(stages, p.stage) || typeof p.is_current !== "boolean" || typeof p.publication_performed !== "boolean" || p.stage === "published" && (!p.is_current || !p.publication_performed)) invalid(value);
      s.receipt = receipt;
      s.progress = p;
      s.denied = false;
      if (s.pending) {
        clear();
        s.pending = null;
      }
      clearTimer(timer);
      if (!terminal.has(p.stage)) timer = setTimer(() => {
        if (current()) void run(poll);
      }, 3e3);
    }
    async function send(s, current) {
      const value = await call("material-transition", s.pending);
      if (!current()) return;
      s.receipt = validateReceipt(value, s);
      s.preview = null;
      await poll(s, current);
    }
    async function restore(documentId, w) {
      reset();
      state = { documentId, busy: false };
      await run(async (s, current) => {
        const saved = read(documentId);
        if (saved) {
          s.pending = saved.input;
          s.error = "\u4E0A\u6B21\u81EA\u52A8\u5904\u7406\u7684\u63D0\u4EA4\u7ED3\u679C\u5F85\u786E\u8BA4\uFF0C\u8BF7\u6062\u590D\u539F\u8BF7\u6C42\u3002";
          return;
        }
        if (w.latest_transition_id && w.processing_mode !== "dialogue") {
          s.receipt = { transition_id: w.latest_transition_id };
          await poll(s, current);
        }
      });
      return !state?.denied;
    }
    async function prepare(documentId) {
      if (state?.busy) return;
      if (state?.documentId !== documentId) {
        reset();
        state = { documentId, busy: false };
      }
      await run(async (s, current) => {
        const saved = read(documentId);
        if (saved) {
          s.pending = saved.input;
          s.error = "\u4E0A\u6B21\u63D0\u4EA4\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u6062\u590D\u539F\u8BF7\u6C42\u3002";
          return;
        }
        if (s.receipt && !terminal.has(s.progress?.stage)) {
          await poll(s, current);
          return;
        }
        const warehouseId = getContext().warehouseId;
        const w = assertWorkflow(await call("material-workflow", { warehouseId, documentId }), documentId);
        if (!current()) return;
        s.denied = false;
        s.preview = null;
        s.receipt = null;
        s.progress = null;
        if (!w.actions.prepare_automatic.allowed) {
          s.error = w.actions.prepare_automatic.reason || "\u5F53\u524D\u6750\u6599\u4E0D\u5141\u8BB8\u8FDB\u5165\u81EA\u52A8\u5904\u7406\u9884\u89C8\u3002";
          return;
        }
        const operationId = crypto.randomUUID();
        const p = await call("material-preview", { warehouseId, documentId, operationId, versionId: w.document_version_id, workflowRevision: w.workflow_revision });
        if (!current()) return;
        s.preview = assertPreview(p, w, operationId);
        s.needsPreview = false;
      });
    }
    async function confirm() {
      await run(async (s, current) => {
        if (s.denied) return;
        if (s.pending) {
          await send(s, current);
          return;
        }
        const p = s.preview;
        if (s.denied || !p?.can_confirm || p.blockers.length) return;
        const saved = read(s.documentId);
        if (saved) {
          s.pending = saved.input;
          s.preview = null;
          s.error = "\u5DF2\u6709\u5C1A\u672A\u786E\u8BA4\u7684\u63D0\u4EA4\uFF0C\u8BF7\u5148\u6062\u590D\u539F\u8BF7\u6C42\u3002";
          return;
        }
        if (Date.now() >= Date.parse(p.expires_at)) {
          s.preview = null;
          s.needsPreview = true;
          s.error = "\u9884\u89C8\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u5E76\u786E\u8BA4\u3002";
          return;
        }
        const input = {
          warehouseId: getContext().warehouseId,
          documentId: s.documentId,
          operationId: crypto.randomUUID(),
          previewId: p.preview_id,
          previewDigest: p.preview_digest,
          workflowRevision: p.workflow_revision,
          confirmed: true,
          ...p.replacement.requires_acknowledgement ? { replacementAcknowledgement: p.replacement.acknowledgement_digest } : {}
        };
        write({ input });
        s.pending = input;
        await send(s, current);
      });
    }
    function render(documentId) {
      const s = state;
      if (!s || s.documentId !== documentId) return "";
      const p = s.preview, r = p?.replacement;
      return `<section class="data-material-automatic" aria-label="\u81EA\u52A8\u5904\u7406\u9884\u89C8\u4E0E\u8FDB\u5EA6">
      ${s.error ? `<p role="alert">${esc2(s.error)}</p>` : ""}
      ${p ? `<h3>\u81EA\u52A8\u5904\u7406\u5F53\u524D\u6750\u6599</h3><p>\u4F7F\u7528\u5F53\u524D\u6B63\u6587\u53CA\u4ED3\u5185\u5DF2\u53D1\u5E03\u672C\u4F53\uFF0C\u6309\u672C\u6B21\u6A21\u578B\u914D\u7F6E\u62BD\u53D6\u3001\u6821\u9A8C\u540E\u81EA\u52A8\u53D1\u5E03\u3002\u4F7F\u7528\u5728\u7EBF\u6A21\u578B\u65F6\uFF0C\u6B63\u6587\u7247\u6BB5\u5C06\u53D1\u9001\u5230\u8BE5\u670D\u52A1\u5E76\u4EA7\u751F\u7528\u91CF\u3002</p>
      ${r ? `<p>\u65E7\u8349\u7A3F ${esc2(r.draft_count)} \u4EFD\uFF08\u4EBA\u5DE5\u4FEE\u6539 ${esc2(r.modified_draft_count)} \u4EFD\uFF09\uFF1B\u65E7\u5019\u9009 ${esc2(r.candidate_result_count)} \u4EFD\uFF08\u4EBA\u5DE5\u4FEE\u6539 ${esc2(r.modified_candidate_result_count)} \u4EFD\uFF09\u3002</p><p>${r.replaces_manual_publication ? "\u672C\u8F6E\u6210\u529F\u540E\u5C06\u66FF\u6362\u5386\u53F2\u4EBA\u5DE5\u53D1\u5E03\u6210\u679C\u3002" : ""}${r.preserves_history ? "\u65E7\u8349\u7A3F\u548C\u5019\u9009\u4FDD\u7559\u4E3A\u5386\u53F2\u3002" : ""}\u5931\u8D25\u6216\u53D6\u6D88\u65F6\u4FDD\u7559\u539F\u53D1\u5E03\u7ED3\u679C\u3002</p><p>${esc2(r.description)}</p>` : ""}
      ${p.blockers.map((b) => `<p role="alert">${esc2(b.detail)}\uFF08${esc2(b.code)}\uFF09</p>`).join("")}
      <button class="button primary" data-data-action="material-auto-confirm" ${s.busy || !p.can_confirm || p.blockers.length ? "disabled" : ""}>${r?.requires_acknowledgement ? "\u786E\u8BA4\u66FF\u6362\u5F71\u54CD\u5E76\u5F00\u59CB\u81EA\u52A8\u5904\u7406" : "\u786E\u8BA4\u5E76\u5F00\u59CB\u81EA\u52A8\u5904\u7406"}</button>
      <button class="button" data-data-action="material-auto-dismiss" ${s.busy ? "disabled" : ""}>\u53D6\u6D88</button>` : ""}
      ${s.progress ? `<p role="status">${esc2(stages[s.progress.is_current ? s.progress.stage : "stale"])}</p>${s.progress.error ? `<p>${esc2(s.progress.error.detail)}\uFF08${esc2(s.progress.error.code)}\uFF09</p>` : ""}` : ""}
      ${s.pending && !s.denied ? `<button class="button" data-data-action="material-auto-confirm" ${s.busy ? "disabled" : ""}>\u6062\u590D\u539F\u786E\u8BA4\u8BF7\u6C42</button>` : ""}
      ${s.receipt && !s.denied ? `<button class="button" data-data-action="material-auto-status" ${s.busy ? "disabled" : ""}>\u5237\u65B0\u5904\u7406\u8FDB\u5EA6</button>` : ""}
      ${s.needsPreview || p && !p.can_confirm ? `<button class="button" data-data-action="material-auto-preview" ${s.busy ? "disabled" : ""}>\u91CD\u65B0\u9884\u89C8</button>` : ""}
      ${s.busy ? '<p role="status">\u6B63\u5728\u8BFB\u53D6\u6216\u63D0\u4EA4\u5904\u7406\u72B6\u6001\u2026</p>' : ""}</section>`;
    }
    async function action(name) {
      if (!name.startsWith("material-auto-")) return false;
      if (name === "material-auto-confirm") await confirm();
      else if (name === "material-auto-status") await run(poll);
      else if (name === "material-auto-preview" && state) await prepare(state.documentId);
      else if (name === "material-auto-dismiss" && state && !state.busy && !state.pending) {
        state.preview = null;
        changed();
      }
      return true;
    }
    return { prepare, restore, reset, render, action };
  }

  // ../builder/integration/team-client/starlink/materials.mjs
  var esc3 = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function createMaterialBrowser({ call, changed, getContext, personal = false }) {
    let key = null, tabs = [], active = null, query = "", collapsed = /* @__PURE__ */ new Set(), sequence = 0;
    const cache = /* @__PURE__ */ new Map();
    let drafts = /* @__PURE__ */ new Map();
    const archives = /* @__PURE__ */ new Map();
    const automatic = createMaterialAutomatic({ call, changed, getContext, getStorage: () => globalThis.window?.localStorage || globalThis.localStorage, onDenied(id2, e) {
      drafts.delete(id2);
      cache.set(id2, { loading: false, text: "", workflowError: "\u6750\u6599\u5904\u7406\u72B6\u6001\u8BFB\u53D6\u5931\u8D25\uFF1A" + materialErrorText(e) });
    } });
    const contextKey = () => JSON.stringify(getContext());
    function reset() {
      automatic.reset();
      if (key && drafts.size) archives.set(key, new Map(drafts));
      drafts = /* @__PURE__ */ new Map();
      key = null;
      tabs = [];
      active = null;
      query = "";
      collapsed.clear();
      cache.clear();
      sequence++;
    }
    function context() {
      const next = contextKey();
      if (next !== key) {
        reset();
        key = next;
        drafts = archives.get(next) || /* @__PURE__ */ new Map();
        archives.delete(next);
      }
      return next;
    }
    async function open(id2, append = false) {
      const captured = context(), warehouseId = getContext().warehouseId, seq = ++sequence;
      if (!warehouseId) return;
      if (!tabs.includes(id2)) tabs.push(id2);
      active = id2;
      const previous = cache.get(id2);
      cache.set(id2, { ...previous, workflow: null, loading: true, error: "" });
      changed();
      const current = () => contextKey() === captured && seq === sequence && active === id2;
      try {
        let value = append ? previous : null;
        if (!value) {
          const source = await call("document", { warehouseId, id: id2 });
          if (!current()) return;
          value = { title: source.document?.original_name || "\u8D44\u6599", versionId: source.version?.id || source.document?.active_version_id, text: "", end: 0, total: 0 };
        }
        if (personal) {
          try {
            value.workflow = await call("material-workflow", { warehouseId, documentId: id2 });
            if (!current()) return;
            assertWorkflow(value.workflow, id2, value.versionId);
            value.workflowError = "";
            if (!append && !await automatic.restore(id2, value.workflow)) return;
            if (!current()) return;
          } catch (e) {
            if (!current()) return;
            automatic.reset();
            value.workflow = null;
            value.workflowError = "\u6750\u6599\u5904\u7406\u72B6\u6001\u8BFB\u53D6\u5931\u8D25\uFF1A" + materialErrorText(e) + "\u3002\u8BF7\u91CD\u65B0\u6253\u5F00\u6750\u6599\u91CD\u8BD5\u3002";
            if (e.httpStatus === 401 || e.httpStatus === 403 || e.httpStatus === 404 || /FORBIDDEN|OWNER_REQUIRED|SESSION|RESOURCE_NOT_FOUND/.test(e.code || "")) {
              drafts.delete(id2);
              cache.set(id2, { workflowError: value.workflowError, loading: false, text: "" });
              return;
            }
          }
        }
        if (!value.versionId) {
          cache.set(id2, { ...value, loading: false, error: "\u6B63\u6587\u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u5728\u5904\u7406\u5B8C\u6210\u540E\u91CD\u65B0\u8BFB\u53D6\u3002" });
          return;
        }
        const part = await call("document-text", { warehouseId, id: id2, versionId: value.versionId, start: append ? value.end : 0 });
        if (!current()) return;
        if (part.version_id !== value.versionId) throw Error("VERSION_CHANGED");
        if (append && part.start !== value.end) throw Error("RANGE_CHANGED");
        cache.set(id2, { ...value, text: append ? value.text + (part.text || "") : part.text || "", end: part.end ?? (part.text || "").length, total: part.total_chars ?? (part.text || "").length, loading: false, error: "" });
      } catch (e) {
        if (current()) {
          const denied = e.httpStatus === 401 || e.httpStatus === 403 || e.httpStatus === 404 || /FORBIDDEN|OWNER_REQUIRED|SESSION|RESOURCE_NOT_FOUND/.test(e.code || "");
          if (denied) {
            drafts.delete(id2);
            automatic.reset();
          }
          cache.set(id2, { ...denied ? { text: "" } : cache.get(id2), workflow: null, loading: false, error: /VERSION|RANGE/.test(String(e.code || e.message)) ? "\u6765\u6E90\u7248\u672C\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\uFF0C\u672A\u62FC\u63A5\u4E0D\u540C\u7248\u672C\u3002" : "\u6B63\u6587\u8BFB\u53D6\u5931\u8D25\uFF1A" + materialErrorText(e) });
        }
      } finally {
        if (current()) changed();
      }
    }
    async function edit() {
      context();
      const id2 = active, captured = key, seq = ++sequence, warehouseId = getContext().warehouseId;
      let all = [], base = null;
      const current = () => contextKey() === captured && active === id2 && seq === sequence;
      cache.set(id2, { ...cache.get(id2), loading: true, error: "" });
      changed();
      try {
        if (personal) {
          const w = assertWorkflow(await call("material-workflow", { warehouseId, documentId: id2 }), id2, cache.get(id2)?.versionId);
          if (!current()) return;
          cache.set(id2, { ...cache.get(id2), workflow: w, workflowError: "" });
          if (!w.actions.edit_source.allowed) {
            cache.set(id2, { ...cache.get(id2), error: w.actions.edit_source.reason || "\u5F53\u524D\u6750\u6599\u4E0D\u5141\u8BB8\u7F16\u8F91\u6B63\u6587\u3002" });
            return;
          }
        }
        let offset = 0, total;
        do {
          const page = await call("document", { warehouseId, id: id2, offset });
          if (!current()) return;
          const version = page.version?.id || page.document?.active_version_id;
          if (!version || base && base !== version) throw Error("\u6765\u6E90\u7248\u672C\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002");
          base = version;
          total = page.document?.segment_count ?? page.segments?.length ?? 0;
          if (!Array.isArray(page.segments) || !page.segments.length || page.segments.some((v) => v.text_truncated)) throw Error("\u6B63\u6587\u672A\u5B8C\u6574\u63D0\u4F9B\uFF0C\u6682\u4E0D\u80FD\u5B89\u5168\u7F16\u8F91\u3002");
          all.push(...page.segments);
          offset += page.segments.length;
          if (all.length > 2e3 || new TextEncoder().encode(all.map((v) => v.text).join("")).length > 768 * 1024) throw Error("\u6B63\u6587\u8FC7\u5927\uFF0C\u8BF7\u5728\u5B8C\u6574\u7248\u5206\u6BB5\u6821\u5BF9\u3002");
        } while (all.length < total);
        if (new Set(all.map((v) => v.id)).size !== all.length) throw Error("\u6765\u6E90\u7247\u6BB5\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002");
        drafts.set(id2, { versionId: base, segments: all.map((v) => ({ id: v.id, text: v.text, original: v.text })), operationId: crypto.randomUUID(), saving: false, error: "" });
      } catch (e) {
        if (current()) {
          const denied = e.httpStatus === 401 || e.httpStatus === 403 || e.httpStatus === 404 || /FORBIDDEN|OWNER_REQUIRED|SESSION|RESOURCE_NOT_FOUND/.test(e.code || "");
          const localErrors = /* @__PURE__ */ new Set(["\u6765\u6E90\u7248\u672C\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002", "\u6B63\u6587\u672A\u5B8C\u6574\u63D0\u4F9B\uFF0C\u6682\u4E0D\u80FD\u5B89\u5168\u7F16\u8F91\u3002", "\u6B63\u6587\u8FC7\u5927\uFF0C\u8BF7\u5728\u5B8C\u6574\u7248\u5206\u6BB5\u6821\u5BF9\u3002", "\u6765\u6E90\u7247\u6BB5\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002"]);
          cache.set(id2, { ...denied ? { text: "" } : cache.get(id2), ...personal && !localErrors.has(e.message) ? { workflow: null, workflowError: "\u6750\u6599\u5904\u7406\u72B6\u6001\u8BFB\u53D6\u5931\u8D25\uFF1A" + materialErrorText(e) } : {}, error: localErrors.has(e.message) ? e.message : "\u672A\u8FDB\u5165\u6B63\u6587\u7F16\u8F91\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u6750\u6599\u72B6\u6001\u3002" });
        }
      } finally {
        if (current()) {
          cache.set(id2, { ...cache.get(id2), loading: false });
          changed();
        }
      }
    }
    async function save() {
      context();
      const id2 = active, d = drafts.get(id2), captured = key;
      if (!d || d.saving) return;
      const hasChanges = d.segments.some((s) => s.text !== s.original), segments = d.segments.map((s) => ({ id: s.id, text: s.text }));
      if (!hasChanges && !d.request) {
        drafts.delete(id2);
        changed();
        return;
      }
      if (new TextEncoder().encode(segments.map((s) => s.text).join("")).length > 768 * 1024) {
        d.error = "\u4FEE\u6539\u5185\u5BB9\u8FC7\u5927\uFF0C\u8BF7\u5206\u6BB5\u6821\u5BF9\u3002";
        changed();
        return;
      }
      d.request ??= { warehouseId: getContext().warehouseId, id: id2, versionId: d.versionId, operationId: d.operationId, segments };
      d.saving = true;
      d.error = "";
      changed();
      try {
        await call("correct", d.request);
        if (contextKey() !== captured) return;
        drafts.delete(id2);
        if (active === id2) await open(id2);
        else cache.delete(id2);
      } catch {
        if (contextKey() === captured) d.error = "\u4FDD\u5B58\u672A\u786E\u8BA4\u6216\u57FA\u7840\u7248\u672C\u5DF2\u53D8\u5316\u3002\u8349\u7A3F\u4FDD\u7559\uFF0C\u53EF\u91CD\u8BD5\u539F\u4FDD\u5B58\uFF1B\u8BF7\u52FF\u8986\u76D6\u4ED6\u4EBA\u7684\u65B0\u7248\u672C\u3002";
      } finally {
        d.saving = false;
        if (contextKey() === captured) changed();
      }
    }
    function input(name, value) {
      if (!name.startsWith("materialSegment_")) return false;
      const d = drafts.get(active), id2 = name.slice(16), s = d?.segments.find((s2) => s2.id === id2);
      if (s && !d.request && !d.saving) s.text = String(value);
      return true;
    }
    function editor(d) {
      return `<form class="data-material-edit" data-data-form="material-save"><p>\u7F16\u8F91\u89E3\u6790\u6B63\u6587 \xB7 \u4FDD\u5B58\u751F\u6210\u65B0\u7248\u672C\uFF0C\u539F\u59CB\u6587\u4EF6\u4FDD\u7559\uFF1B\u540E\u7EED\u6309\u672C\u4ED3\u5DF2\u786E\u8BA4\u7684\u6A21\u578B\u914D\u7F6E\u5904\u7406\uFF1B\u82E5\u4F7F\u7528\u5728\u7EBF\u6A21\u578B\uFF0C\u4FEE\u6539\u540E\u7684\u6B63\u6587\u4E5F\u4F1A\u53D1\u9001\u5230\u5BF9\u5E94\u670D\u52A1\u3002</p>${d.error ? `<p role="alert">${esc3(d.error)}</p>` : ""}${d.segments.map((s, i) => `<label>\u7247\u6BB5 ${i + 1}<textarea name="materialSegment_${esc3(s.id)}" data-studio-edit-key="materialSegment_${esc3(s.id)}" ${d.saving || d.request ? "readonly" : ""}>${esc3(s.text)}</textarea></label>`).join("")}<div><button class="button primary" ${d.saving ? "disabled" : ""}>${d.saving ? "\u4FDD\u5B58\u4E2D\u2026" : d.request ? "\u91CD\u8BD5\u539F\u4FDD\u5B58" : "\u4FDD\u5B58\u65B0\u7248\u672C"}</button><button type="button" class="button" data-data-action="material-cancel" ${d.saving ? "disabled" : ""}>\u53D6\u6D88\u7F16\u8F91</button></div></form>`;
    }
    function render({ documents, total, offset, pagination, isLoading }) {
      context();
      const shown = documents.filter((d) => (d.original_name || "").toLocaleLowerCase().includes(query.toLocaleLowerCase())), groups = /* @__PURE__ */ new Map();
      for (const d of shown) {
        const type = (d.document_format || d.original_name?.split(".").pop() || "\u5176\u4ED6").toUpperCase();
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push(d);
      }
      const n = cache.get(active), draft = drafts.get(active), name = (id2) => cache.get(id2)?.title || documents.find((d) => d.id === id2)?.original_name || "\u8D44\u6599";
      return `<section class="data-file-workspace" aria-label="\u8D44\u6599\u6D4F\u89C8\u4E0E\u9884\u89C8"><aside class="data-file-tree"><header><strong>\u4ED3\u91CC\u7684\u8D44\u6599</strong><small>\u6309\u6587\u4EF6\u7C7B\u578B\u6D4F\u89C8 \xB7 ${total} \u4EFD\u8D44\u6599</small></header><form data-data-form="material-filter"><input name="materialFilter" data-studio-edit-key="material-filter" value="${esc3(query)}" placeholder="\u67E5\u627E\u5F53\u524D\u5217\u8868" aria-label="\u67E5\u627E\u5F53\u524D\u8D44\u6599\u5217\u8868"><button class="button">\u67E5\u627E</button></form><div class="data-file-list">${[...groups].map(([type, items]) => `<button class="data-file-folder" data-data-action="material-folder" data-type="${esc3(type)}" aria-expanded="${!collapsed.has(type)}">${collapsed.has(type) ? "\u25B8" : "\u25BE"} ${esc3(type)} <small>${items.length}</small></button>${collapsed.has(type) ? "" : items.map((d) => `<button class="data-file-row ${active === d.id ? "active" : ""}" data-data-action="material-open" data-id="${esc3(d.id)}" title="${esc3(d.original_name)}" ${active === d.id ? 'aria-current="page"' : ""}><span aria-hidden="true">\u25A4</span><span>${esc3(d.original_name)}</span><small>${esc3(d.workflow?.label || (d.job_status === "failed" ? "\u5904\u7406\u5931\u8D25" : d.status === "ready" ? "\u5DF2\u89E3\u6790" : "\u5904\u7406\u4E2D"))}</small></button><button class="text-button" data-data-action="delete-material" data-id="${esc3(d.id)}" aria-label="\u5220\u9664 ${esc3(d.original_name)}">\u5220\u9664</button>`).join("")}`).join("") || `<p>${isLoading ? "\u6B63\u5728\u8BFB\u53D6\u8D44\u6599\u2026" : query ? "\u5F53\u524D\u5217\u8868\u672A\u627E\u5230\u8D44\u6599\u3002" : "\u5BFC\u5165\u4E00\u4EFD\u8D44\u6599\uFF0C\u4ECE\u8FD9\u91CC\u5F00\u59CB\u9605\u8BFB\u3002"}</p>`}</div>${pagination || ""}<footer>${total ? offset + 1 : 0}\u2013${Math.min(offset + documents.length, total)} / ${total}</footer></aside><main class="data-file-main"><nav class="data-file-tabs" aria-label="\u5DF2\u6253\u5F00\u8D44\u6599">${tabs.map((id2) => `<div class="${active === id2 ? "active" : ""}"><button data-data-action="material-open" data-id="${esc3(id2)}" title="${esc3(name(id2))}">${esc3(name(id2))}</button><button data-data-action="material-close" data-id="${esc3(id2)}" aria-label="\u5173\u95ED ${esc3(name(id2))}">\xD7</button></div>`).join("")}</nav>${active ? `<header class="data-file-preview-bar"><div><strong>${esc3(name(active))}</strong><small>${draft ? "\u7F16\u8F91\u6B63\u6587" : "\u6B63\u6587\u9884\u89C8"}${n?.versionId ? " \xB7 \u56FA\u5B9A\u7248\u672C " + esc3((draft?.versionId || n.versionId).slice(0, 8)) : ""}</small></div>${draft ? `<div><button class="button primary" data-data-action="material-save" ${draft.saving ? "disabled" : ""}>${draft.saving ? "\u4FDD\u5B58\u4E2D\u2026" : draft.request ? "\u91CD\u8BD5\u539F\u4FDD\u5B58" : "\u4FDD\u5B58\u65B0\u7248\u672C"}</button><button class="button" data-data-action="material-cancel" ${draft.saving ? "disabled" : ""}>\u53D6\u6D88</button></div>` : `<button class="button" data-data-action="material-edit" ${n?.loading || !n?.versionId || personal && n?.workflow?.actions?.edit_source?.allowed !== true ? "disabled" : ""}>\u7F16\u8F91\u6B63\u6587</button><button class="button" data-data-action="reextract-document" data-id="${esc3(active)}" data-version-id="${esc3(n?.versionId)}" ${n?.loading || !n?.versionId || personal && n?.workflow?.actions?.prepare_automatic?.allowed !== true ? "disabled" : ""}>\u91CD\u65B0\u62BD\u53D6</button>`}</header><div class="data-file-reading" aria-busy="${Boolean(n?.loading)}">${workflowHTML(n)}${automatic.render(active)}${n?.loading ? '<p role="status">\u6B63\u5728\u8BFB\u53D6\u6B63\u6587\u2026</p>' : ""}${n?.error ? `<p role="alert">${esc3(n.error)}</p>` : ""}${draft ? editor(draft) : `<pre>${esc3(n?.text || "")}</pre>`}${n && !n.loading && !n.error && !n.text ? "<p>\u6B64\u8D44\u6599\u6682\u65E0\u53EF\u9884\u89C8\u6B63\u6587\u3002</p>" : ""}${!draft && n?.end < n?.total ? `<button class="button" data-data-action="material-more" ${n.loading ? "disabled" : ""}>\u7EE7\u7EED\u8BFB\u53D6\u6B63\u6587\uFF08${n.end} / ${n.total}\uFF09</button>` : ""}</div><footer class="data-file-preview-note">PDF\u3001\u56FE\u7247\u3001\u8868\u683C\u548C\u97F3\u9891\u5C55\u793A\u89E3\u6790\uFF0F\u8BC6\u522B\u540E\u7684\u6B63\u6587\uFF1B\u539F\u4EF6\u548C\u5386\u53F2\u8BB0\u5F55\u4FDD\u6301\u4E0D\u53D8\u3002</footer>` : '<div class="data-file-empty"><span>\u25A4</span><h3>\u4ECE\u5DE6\u4FA7\u6253\u5F00\u4E00\u4EFD\u8D44\u6599</h3><p>\u5728\u6807\u7B7E\u9875\u4E4B\u95F4\u5207\u6362\u9605\u8BFB\uFF0C\u53EF\u9884\u89C8\u6B63\u6587\uFF0C\u4E5F\u53EF\u7F16\u8F91\u5E76\u4FDD\u5B58\u65B0\u7248\u672C\u3002</p></div>'}</main></section>`;
    }
    function workflowHTML(n) {
      if (!personal || !n) return "";
      const w = n.workflow;
      if (!w) return `<p role="status">${esc3(n.workflowError || "\u6B63\u5728\u8BFB\u53D6\u6750\u6599\u5904\u7406\u72B6\u6001\u2026")}</p>`;
      const links = (w.conversations || []).filter((l) => l.conversation_status === "active");
      return `<section aria-label="\u6750\u6599\u5904\u7406\u72B6\u6001"><strong>${esc3(w.label)}</strong><p>${w.processing_mode === "dialogue" ? "\u5BF9\u8BDD\u6838\u5BF9 \xB7 \u786E\u8BA4\u540E\u53D1\u5E03" : "\u81EA\u52A8\u5904\u7406"}${w.publication ? " \xB7 \u5DF2\u6709\u53D1\u5E03\u7ED3\u679C" : ""}</p>
    ${(w.tasks || []).map((t) => `<p>${esc3(t.stage)} \xB7 ${esc3(t.completed_units)} / ${esc3(t.total_units ?? "\u5F85\u786E\u5B9A")}</p>`).join("")}
    <p>${esc3(w.actions.edit_source.allowed ? "" : w.actions.edit_source.reason || "\u5F53\u524D\u6750\u6599\u4E0D\u5141\u8BB8\u7F16\u8F91\u6B63\u6587\u3002")}</p>
    <p>${esc3(w.actions.prepare_automatic.allowed ? "" : w.actions.prepare_automatic.reason || "\u5F53\u524D\u6750\u6599\u4E0D\u5141\u8BB8\u81EA\u52A8\u5904\u7406\u3002")}</p>
    ${links.map((l) => `<button class="button primary" data-data-action="material-dialogue" data-conversation="${esc3(l.conversation_id)}" data-intent="${esc3(l.intent_id)}">\u5728\u661F\u56FE\u7EE7\u7EED\u5BF9\u8BDD</button>`).join("")}
    ${links.length ? "<p>\u8DF3\u8F6C\u53EA\u6253\u5F00\u6750\u6599\uFF1B\u62BD\u53D6\u3001\u4FEE\u6539\u548C\u53D1\u5E03\u4ECD\u9700\u5728\u661F\u56FE\u4E2D\u786E\u8BA4\u3002</p>" : ""}</section>`;
    }
    async function dialogue(data) {
      const captured = context(), id2 = active, warehouseId = getContext().warehouseId;
      if (!personal || !id2) return;
      const w = await call("material-workflow", { warehouseId, documentId: id2 });
      if (contextKey() !== captured || active !== id2) return;
      if (w.document_id !== id2) throw Error("TEAM_DATA_RESPONSE_INVALID");
      const link = data.conversation ? w.conversations.find((l) => l.conversation_id === data.conversation && l.intent_id === data.intent && l.conversation_status === "active") : null;
      if (data.conversation && !link) throw Error("MODELING_SOURCE_CHANGED");
      await call("open-starlink", { warehouseId, view: "conversation", documentId: id2, ...link ? { conversationId: link.conversation_id, intentId: link.intent_id } : {} });
    }
    async function action(name, data) {
      if (name === "reextract-document" && personal) {
        context();
        if (active !== data.id) await open(data.id);
        const n = cache.get(data.id);
        if (n?.workflow && !n.loading && n.workflow.actions.prepare_automatic.allowed) await automatic.prepare(data.id);
        return true;
      }
      if (!name.startsWith("material-")) return false;
      context();
      if (await automatic.action(name)) return true;
      if (name === "material-dialogue") {
        await dialogue(data);
        return true;
      }
      if (name === "material-edit") {
        if (!personal || cache.get(active)?.workflow?.actions?.edit_source?.allowed) await edit();
        return true;
      }
      if (name === "material-save") {
        await save();
        return true;
      }
      if (name === "material-cancel") {
        const d = drafts.get(active);
        if (d?.saving) return true;
        if (globalThis.confirm?.("\u653E\u5F03\u6B64\u8349\u7A3F\u5E76\u91CD\u65B0\u8BFB\u53D6\u670D\u52A1\u7AEF\u7248\u672C\uFF1F\u539F\u6587\u4EF6\u4E0D\u4F1A\u88AB\u5220\u9664\u3002") === false) return true;
        drafts.delete(active);
        await open(active);
        return true;
      }
      if (name === "material-open") await open(data.id);
      else if (name === "material-more" && active) await open(active, true);
      else if (name === "material-folder") {
        collapsed.has(data.type) ? collapsed.delete(data.type) : collapsed.add(data.type);
        changed();
      } else if (name === "material-close") {
        if (drafts.has(data.id)) {
          if (drafts.get(data.id).saving) return true;
          if (globalThis.confirm?.("\u5173\u95ED\u540E\u4FDD\u7559\u672C\u6B21\u4F1A\u8BDD\u7684\u7F16\u8F91\u8349\u7A3F\uFF0C\u91CD\u65B0\u6253\u5F00\u53EF\u7EE7\u7EED\u3002") === false) return true;
        }
        if (active === data.id) {
          sequence++;
          automatic.reset();
        }
        cache.delete(data.id);
        tabs = tabs.filter((id2) => id2 !== data.id);
        if (active === data.id) {
          active = tabs.at(-1) || null;
          if (active) await open(active);
        }
        changed();
      }
      return true;
    }
    globalThis.window?.addEventListener?.("beforeunload", (event) => {
      if (drafts.size || [...archives.values()].some((m) => m.size)) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    return { render, action, reset, input, remove(id2) {
      automatic.reset();
      sequence++;
      cache.delete(id2);
      drafts.delete(id2);
      for (const saved of archives.values()) saved.delete(id2);
      tabs = tabs.filter((value) => value !== id2);
      if (active === id2) active = null;
      changed();
    }, hasDrafts: () => drafts.size > 0, filter(value) {
      query = String(value);
      changed();
    } };
  }

  // ../builder/integration/team-client/starlink/editing.mjs
  function createGraphComposition(getContext) {
    let input = null, context = null;
    const current = () => Boolean(input?.isConnected && context === getContext());
    return {
      start(target) {
        const form = target?.closest?.("[data-data-form]");
        if (!["search", "graph-search"].includes(form?.dataset.dataForm) || form.dataset.dataContext !== getContext()) return;
        input = target;
        context = getContext();
      },
      active: current,
      end(target) {
        if (target !== input) return null;
        const result = current() ? { name: input.name, value: input.value } : null;
        input = null;
        context = null;
        return result;
      }
    };
  }
  function retainGraphInput(root, document2) {
    const input = document2.activeElement;
    const form = input?.closest?.("[data-data-form]");
    const kind = form?.dataset.dataForm;
    const name = kind === "search" ? "query" : kind === "graph-search" ? "graphQuery" : null;
    const context = form?.dataset.dataContext;
    if (!name || input.name !== name || !context || !root?.contains?.(input)) return () => {
    };
    const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
    return () => {
      const next = root.querySelector(`[data-data-form="${kind}"] input[name="${name}"]`);
      if (!next || next.closest("[data-data-form]")?.dataset.dataContext !== context) return;
      next.replaceWith(input);
      input.focus({ preventScroll: true });
      if (start !== null && end !== null) input.setSelectionRange(start, end, direction);
    };
  }

  // ../builder/integration/team-client/starlink/quick-warehouse.mjs
  function createWarehouseJournal(getStorage) {
    const key = (scope) => "wanx.quick-warehouse:" + scope;
    const storage = () => {
      const value = typeof getStorage === "function" ? getStorage() : getStorage;
      if (!value) throw Error("WAREHOUSE_RECOVERY_UNAVAILABLE");
      return value;
    };
    return {
      read(scope) {
        try {
          if (!scope) throw Error();
          const value = JSON.parse(storage().getItem(key(scope)) || "null");
          if (value !== null && (!value.input || typeof value.input.name !== "string" || typeof value.input.description !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.input.operationId) || value.id !== void 0 && (typeof value.id !== "string" || !value.id))) throw Error();
          return value;
        } catch {
          throw Error("WAREHOUSE_RECOVERY_UNAVAILABLE");
        }
      },
      write(scope, value) {
        try {
          const text = JSON.stringify(value);
          if (!scope) throw Error();
          storage().setItem(key(scope), text);
        } catch {
          throw Error("WAREHOUSE_RECOVERY_UNAVAILABLE");
        }
      },
      clear(scope) {
        try {
          storage().removeItem(key(scope));
        } catch {
          throw Error("WAREHOUSE_RECOVERY_UNAVAILABLE");
        }
      }
    };
  }
  function warehouseRecoveryScope(state, edition) {
    const device = state.activeDeviceId || state.connection?.deviceId;
    const owner = state.dataOwnerId || !state.dataIdentity?.profileId && state.account?.accountId;
    if (!owner || !device) return null;
    return JSON.stringify([edition, owner, device, state.dataIdentity?.clientId || state.account?.clientId || null]);
  }
  function warehouseInput(name, description) {
    name = String(name || "");
    description = String(description || "");
    if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw Error("WAREHOUSE_NAME_INVALID");
    name = name.trim();
    if (!name || [...name].length > 60) throw Error("WAREHOUSE_NAME_INVALID");
    if ([...description].length > 500) throw Error("WAREHOUSE_DESCRIPTION_INVALID");
    return { name, description };
  }
  function ontologySummary(value) {
    if (!value || value.status !== "published") return "\u5F53\u524D\u670D\u52A1\u672A\u63D0\u4F9B\u5DF2\u751F\u6548\u7684\u77E5\u8BC6\u7ED3\u6784\uFF0C\u8BF7\u5237\u65B0\u6838\u5BF9\u3002";
    const label = value.template_id === "personal_general" ? "\u901A\u7528\u77E5\u8BC6\u7ED3\u6784\u5DF2\u751F\u6548" : "\u77E5\u8BC6\u7ED3\u6784\u5DF2\u751F\u6548";
    return [
      label,
      value.name,
      value.version_number != null ? `\u4ED3\u5185\u7248\u672C ${value.version_number}` : "",
      value.template_version != null ? `\u6A21\u677F\u7248\u672C ${value.template_version}` : "",
      Number.isInteger(value.entity_type_count) ? `${value.entity_type_count} \u7C7B\u5B9E\u4F53` : "",
      Number.isInteger(value.relation_type_count) ? `${value.relation_type_count} \u7C7B\u5173\u7CFB` : ""
    ].filter(Boolean).join(" \xB7 ");
  }

  // ../builder/integration/team-client/starlink/rename-warehouse.mjs
  var uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
  function createWarehouseRenameJournal(getStorage) {
    const key = (scope, id2) => {
      if (!scope || !uuid(id2)) throw Error("WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE");
      return "wanx.warehouse-rename:" + scope + ":" + id2;
    };
    const storage = () => typeof getStorage === "function" ? getStorage() : getStorage;
    const validate = (value, id2) => {
      if (value === null) return null;
      if (!value || Object.keys(value).some((k) => !["input", "saved"].includes(k)) || typeof value.saved !== "boolean" || !value.input || Object.keys(value.input).sort().join(",") !== "name,operationId,warehouseId" || value.input.warehouseId !== id2 || !uuid(value.input.operationId) || typeof value.input.name !== "string" || warehouseInput(value.input.name, "").name !== value.input.name) throw Error();
      return value;
    };
    return {
      read(scope, id2) {
        try {
          return validate(JSON.parse(storage().getItem(key(scope, id2)) || "null"), id2);
        } catch {
          throw Error("WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE");
        }
      },
      write(scope, id2, value) {
        try {
          validate(value, id2);
          storage().setItem(key(scope, id2), JSON.stringify(value));
        } catch {
          throw Error("WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE");
        }
      },
      clear(scope, id2) {
        try {
          storage().removeItem(key(scope, id2));
        } catch {
          throw Error("WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE");
        }
      }
    };
  }

  // ../builder/integration/team-client/data-view.js
  window.createTeamDataView = ({ request, changed, edition = "team" }) => {
    const graphMotion = createGraphMotion();
    const team = edition === "team", owner = team ? "\u56E2\u961F" : "\u4E2A\u4EBA";
    const warehouseJournal = createWarehouseJournal(() => window.localStorage);
    const renameJournal = createWarehouseRenameJournal(() => window.localStorage);
    let ontologyDetail = null, ontologyError = "", recoveryScope = null;
    const esc4 = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const names = { queued: "\u6392\u961F\u4E2D", running: "\u5904\u7406\u4E2D", processing: "\u5904\u7406\u4E2D", ready: "\u6B63\u6587\u5C31\u7EEA", succeeded: "\u5DF2\u5B8C\u6210", failed: "\u5931\u8D25", cancelled: "\u5DF2\u53D6\u6D88", active: "\u53EF\u7528", importing: "\u8FC1\u5165\u4E2D", clearing: "\u6E05\u7406\u4E2D", deleting: "\u5220\u9664\u4E2D" };
    const jobNames = { document_parse: "\u6750\u6599\u89E3\u6790", ontology_suggest: "\u672C\u4F53\u5EFA\u8BAE", knowledge_extract: "\u77E5\u8BC6\u62BD\u53D6", knowledge_publish: "\u56FE\u8C31\u5199\u5165", knowledge_retract: "\u56FE\u8C31\u66F4\u65B0", sensitive_scan: "\u4FDD\u62A4\u68C0\u6D4B", search_index: "\u68C0\u7D22\u7D22\u5F15", search_index_build: "\u68C0\u7D22\u7D22\u5F15" };
    const stageNames = { accepted: "\u7B49\u5F85\u5904\u7406", retry_queued: "\u7B49\u5F85\u91CD\u8BD5", generating_suggestions: "\u751F\u6210\u5EFA\u8BAE", extracting_entities: "\u62BD\u53D6\u5B9E\u4F53", extracting_relations: "\u62BD\u53D6\u5173\u7CFB", completed: "\u5DF2\u5B8C\u6210", failed: "\u5904\u7406\u5931\u8D25", cancelled: "\u5DF2\u53D6\u6D88", publishing: "\u6B63\u5728\u5199\u5165\u56FE\u8C31", published: "\u56FE\u8C31\u5DF2\u5199\u5165", review_ready: "\u62BD\u53D6\u5B8C\u6210", index_ready: "\u7D22\u5F15\u5C31\u7EEA", superseded: "\u5DF2\u88AB\u65B0\u4EFB\u52A1\u53D6\u4EE3" };
    const tabs = [["graph", "\u77E5\u8BC6\u56FE\u8C31"], ["materials", "\u8D44\u6599"]];
    let scope = null, admin = false, epoch = 0, loading = false, searching = false, busy = false, error = "", errorCode = "", warehouses = [], warehouseId = null, tab = "graph", query = "", filter = "", documents = [], jobs = [], graph = { nodes: [], edges: [] }, results = [], retrieval = null, node = null, offset = 0, total = 0, initialized = false;
    let overviewWarehouseId = null, graphError = "", graphQuery = "", graphType = "all", edge = null, zoom = 1, graphCache = null;
    let constellation = null, starMetric = "relations", showIsolated = false;
    let refreshTimer, loadingTimer, contentReady = false, refreshVisible = false, refreshing = false;
    let sharePreview = null, shareError = "", governance = null, governanceError = "", reviews = [], reviewTotal = 0, reviewsOffset = 0, review = null, proposal = null, panel = null, panelLoading = false, sourceValue = null, pendingGovernance = null, detailSequence = 0, governanceWriting = false;
    const defaultTypeInfo = {
      PERSON: ["\u4EBA\u7269", "\u4EBA", "#7a91a9"],
      ORG: ["\u7EC4\u7EC7", "\u7EC4", "#7c967e"],
      GPE: ["\u5730\u70B9", "\u5730", "#739b92"],
      EVENT: ["\u4E8B\u4EF6", "\u4E8B", "#8c83a6"],
      CONCEPT: ["\u6982\u5FF5", "\u77E5", "#b28f93"],
      DOCUMENT: ["\u6750\u6599", "\u6587", "#9c9780"],
      PRODUCT: ["\u4EA7\u54C1\u4E0E\u7CFB\u7EDF", "\u54C1", "#b89561"],
      FEATURE: ["\u529F\u80FD", "\u529F", "#ac986d"],
      TECHNOLOGY: ["\u65B9\u6CD5\u4E0E\u6280\u672F", "\u6280", "#8b8faa"],
      DATE: ["\u65E5\u671F", "\u65E5", "#899da9"],
      PROJECT: ["\u9879\u76EE", "\u9879", "#7b8d70"],
      BUSINESS_OBJECT: ["\u4E1A\u52A1\u5BF9\u8C61", "\u4E1A", "#b18564"],
      PROCESS: ["\u6D41\u7A0B", "\u6D41", "#63958c"],
      TASK: ["\u4EFB\u52A1", "\u4EFB", "#9a7d9c"],
      METRIC: ["\u6307\u6807", "\u6307", "#688da7"],
      ISSUE: ["\u95EE\u9898\u4E0E\u98CE\u9669", "\u9669", "#b47872"],
      OTHER: ["\u5176\u5B83", "\u5176", "#8d8a86"]
    };
    function customTypeColor(type) {
      let hash = 0;
      for (const char of type) hash = Math.imul(hash, 31) + char.codePointAt(0) >>> 0;
      return ["#768fb4", "#aa856f", "#8b91b0", "#729d84", "#ad8499", "#9b9b65"][hash % 6];
    }
    const defaultRelationNames = { PREFERS: "\u60C5\u5883\u504F\u597D", FOUNDED: "\u521B\u529E", CREATED: "\u521B\u5EFA", PART_OF: "\u5C5E\u4E8E", HAS_FEATURE: "\u5177\u6709\u529F\u80FD", USES: "\u4F7F\u7528", OCCURRED_AT: "\u53D1\u751F\u4E8E", WORKS_AT: "\u4EFB\u804C\u4E8E", LOCATED_IN: "\u4F4D\u4E8E" };
    const graphWarehouse = () => warehouses.find((w) => w.id === (warehouseId || overviewWarehouseId));
    function clearGraph() {
      showIsolated = false;
      graphMotion.reset();
      graph = { nodes: [], edges: [] };
      graphError = "";
      graphCache = null;
      node = null;
      edge = null;
      zoom = 1;
      graphQuery = "";
      graphType = "all";
      constellation = null;
    }
    const code = (e) => String(e?.code || e?.message || "");
    const invalidScope = (e) => e?.httpStatus === 401 || e?.httpStatus === 403 || /ADMIN_REQUIRED|OWNER_REQUIRED|SESSION|AUTH|FORBIDDEN/.test(code(e));
    const message = (e) => {
      const c = code(e);
      const creationErrors = { WAREHOUSE_NAME_CONFLICT: "\u5DF2\u6709\u540C\u540D\u6570\u636E\u4ED3\uFF0C\u8BF7\u4FEE\u6539\u540D\u79F0\u3002", WAREHOUSE_NAME_INVALID: "\u8BF7\u586B\u5199 1 \u81F3 60 \u5B57\u7B26\u7684\u540D\u79F0\uFF0C\u4E0D\u5305\u542B\u63A7\u5236\u5B57\u7B26\u3002", WAREHOUSE_DESCRIPTION_INVALID: "\u8BF4\u660E\u4E0D\u80FD\u8D85\u8FC7 500 \u5B57\u7B26\u3002", WAREHOUSE_RECOVERY_UNAVAILABLE: "\u65E0\u6CD5\u4FDD\u5B58\u6216\u8BFB\u53D6\u5EFA\u4ED3\u6062\u590D\u8BB0\u5F55\uFF0C\u8BF7\u68C0\u67E5\u672C\u5730\u5B58\u50A8\u540E\u91CD\u8BD5\u3002", WAREHOUSE_CREATION_PENDING: "\u4E0A\u6B21\u5EFA\u4ED3\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u6062\u590D\u539F\u8BF7\u6C42\uFF0C\u4E0D\u80FD\u66F4\u6362\u5185\u5BB9\u91CD\u590D\u5EFA\u4ED3\u3002", WAREHOUSE_CREATION_INVALID: "\u540D\u79F0\u6216\u8BF4\u660E\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u8BF7\u4FEE\u6539\u540E\u91CD\u8BD5\u3002", WAREHOUSE_CREATION_UNCERTAIN: "\u5EFA\u4ED3\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u5DF2\u4FDD\u7559\u539F\u8BF7\u6C42\u3002\u8BF7\u91CD\u8BD5\u6216\u91CD\u65B0\u6253\u5F00\u5EFA\u4ED3\u7A97\u53E3\u6062\u590D\uFF0C\u52FF\u91CD\u590D\u65B0\u5EFA\u3002", WAREHOUSE_CREATION_CONFLICT: "\u64CD\u4F5C\u53F7\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u6062\u590D\u539F\u8BF7\u6C42\u6838\u5BF9\uFF0C\u4E0D\u80FD\u76F2\u76EE\u91CD\u8BD5\u3002" };
      if (creationErrors[c]) return creationErrors[c];
      const renameErrors = { WAREHOUSE_INVALID_NAME: "\u8BF7\u586B\u5199 1 \u81F3 60 \u5B57\u7B26\u7684\u540D\u79F0\uFF0C\u4E0D\u5305\u542B\u63A7\u5236\u5B57\u7B26\u3002", WAREHOUSE_RENAME_PENDING: "\u4E0A\u6B21\u4FDD\u5B58\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u91CD\u8BD5\u539F\u540D\u79F0\u3002", WAREHOUSE_RENAME_UNCERTAIN: "\u540D\u79F0\u4FDD\u5B58\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u91CD\u8BD5\u4FDD\u5B58\u3002", WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE: "\u65E0\u6CD5\u4FDD\u5B58\u6216\u8BFB\u53D6\u5F85\u786E\u8BA4\u7684\u6539\u540D\u8BB0\u5F55\uFF0C\u8BF7\u68C0\u67E5\u672C\u5730\u5B58\u50A8\u540E\u91CD\u8BD5\u3002", WAREHOUSE_RENAME_CONFLICT: "\u4E0A\u6B21\u4FDD\u5B58\u8BF7\u6C42\u4E0E\u670D\u52A1\u7AEF\u8BB0\u5F55\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u6838\u5BF9\u539F\u64CD\u4F5C\u540E\u91CD\u8BD5\u3002" };
      if (renameErrors[c]) return renameErrors[c];
      if (c === "MODELING_CONFIRMATION_REQUIRED") return "\u6B64\u6750\u6599\u5C5E\u4E8E\u5BF9\u8BDD\u5EFA\u6A21\u6750\u6599\uFF0C\u4E0D\u652F\u6301\u666E\u901A\u81EA\u52A8\u62BD\u53D6\u3002\u5F53\u524D\u5165\u53E3\u4EC5\u5904\u7406\u666E\u901A\u6750\u6599\uFF0C\u672A\u8F6C\u6362\u6750\u6599\u7C7B\u578B\u3002";
      if (c === "TEAM_DATA_REVIEW_CHANGED") return "\u5EFA\u8BAE\u5DF2\u4FDD\u5B58\u5728\u539F\u4E8B\u9879\u4E2D\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u539F\u4E8B\u9879\u6838\u5BF9\uFF0C\u672A\u5E94\u7528\u5230\u5F53\u524D\u9009\u62E9\u3002";
      if (c === "TEAM_DATA_OPERATION_UNCONFIRMED") return "\u4E0A\u4E00\u9879\u64CD\u4F5C\u7684\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u67E5\u8BE2\u6216\u91CD\u8BD5\u539F\u64CD\u4F5C\uFF0C\u518D\u53D1\u8D77\u65B0\u7684\u4FEE\u6539\u3002";
      if (c.startsWith("WAREHOUSE_GOVERNANCE_")) return { REVISION_CONFLICT: "\u6838\u5BF9\u4E8B\u9879\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u786E\u8BA4\u3002", SOURCE_CHANGED: "\u6765\u6E90\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u5E76\u91CD\u65B0\u6838\u5BF9\u5F53\u524D\u6765\u6E90\u3002", DRAFT_CHANGED: "\u77E5\u8BC6\u8349\u7A3F\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u6838\u5BF9\u3002", TARGET_CHANGED: "\u76EE\u6807\u77E5\u8BC6\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u6838\u5BF9\u3002", REVIEW_CLOSED: "\u6B64\u6838\u5BF9\u4E8B\u9879\u5DF2\u5173\u95ED\uFF0C\u8BF7\u5237\u65B0\u5217\u8868\u3002", HUMAN_EDIT_PROTECTED: "\u8FD9\u9879\u77E5\u8BC6\u5305\u542B\u4EBA\u5DE5\u4FEE\u6B63\uFF0C\u8BF7\u901A\u8FC7\u77E5\u8BC6\u6CBB\u7406\u529F\u80FD\u6838\u5BF9\u3002", MULTI_SOURCE_REVIEW_REQUIRED: "\u8FD9\u9879\u4FEE\u6539\u6D89\u53CA\u591A\u4EFD\u8D44\u6599\uFF0C\u8BF7\u901A\u8FC7\u77E5\u8BC6\u6CBB\u7406\u529F\u80FD\u6838\u5BF9\u3002", SOURCE_REVIEW_REQUIRED: "\u8BF7\u5148\u6838\u5BF9\u6765\u6E90\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u4FEE\u6539\u3002", OPERATION_CONFLICT: "\u6B64\u64CD\u4F5C\u6807\u8BC6\u5BF9\u5E94\u7684\u5185\u5BB9\u4E0D\u540C\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u786E\u8BA4\u3002", MODEL_OUTPUT_INVALID: "\u6A21\u578B\u672A\u8FD4\u56DE\u53EF\u9A8C\u8BC1\u7684\u4FEE\u6539\u5EFA\u8BAE\uFF0C\u539F\u77E5\u8BC6\u4FDD\u6301\u4E0D\u53D8\u3002", MODEL_EVIDENCE_INVALID: "\u6A21\u578B\u5F15\u7528\u7684\u8BC1\u636E\u672A\u901A\u8FC7\u6821\u9A8C\uFF0C\u539F\u77E5\u8BC6\u4FDD\u6301\u4E0D\u53D8\u3002", MODEL_EVIDENCE_INSUFFICIENT: "\u73B0\u6709\u8BC1\u636E\u4E0D\u8DB3\u4EE5\u652F\u6301\u5EFA\u8BAE\uFF0C\u4FDD\u7559\u5F85\u6838\u5BF9\u3002", MODEL_VALIDATION_FAILED: "\u6A21\u578B\u5EFA\u8BAE\u672A\u901A\u8FC7\u6821\u9A8C\uFF0C\u539F\u77E5\u8BC6\u4FDD\u6301\u4E0D\u53D8\u3002", IDENTITY_REVIEW_REQUIRED: "\u8EAB\u4EFD\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u6838\u5BF9\u8EAB\u4EFD\uFF0C\u4E0D\u80FD\u4F5C\u4E3A\u8DE8\u8D44\u6599\u8FDE\u63A5\u3002", AI_UNAVAILABLE: "\u5F53\u524D\u5904\u7406\u6A21\u578B\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u6A21\u578B\u4E0E\u5904\u7406\u914D\u7F6E\u3002", PROPOSAL_NOT_READY: "\u5EFA\u8BAE\u5C1A\u672A\u51C6\u5907\u5B8C\u6210\u6216\u8BC1\u636E\u4E0D\u8DB3\uFF0C\u5F53\u524D\u4E0D\u80FD\u5E94\u7528\u3002", CONFIRMATION_REQUIRED: "\u8BF7\u5148\u6838\u5BF9\u4FEE\u6539\u5185\u5BB9\u5E76\u660E\u786E\u786E\u8BA4\u3002", PROPOSAL_IN_PROGRESS: "\u539F\u5EFA\u8BAE\u64CD\u4F5C\u4ECD\u5728\u540E\u53F0\u5904\u7406\u4E2D\u6216\u66FE\u88AB\u4E2D\u65AD\uFF0C\u8BF7\u5237\u65B0\u4E8B\u9879\u6838\u5BF9\uFF0C\u670D\u52A1\u7AEF\u4E0D\u4F1A\u91CD\u590D\u53D1\u8D77\u6A21\u578B\u8C03\u7528\u3002" }[c.slice("WAREHOUSE_GOVERNANCE_".length)] || "\u6CBB\u7406\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u5237\u65B0\u4E8B\u9879\u6838\u5BF9\u539F\u56E0\uFF1B\u539F\u77E5\u8BC6\u5C1A\u672A\u6539\u5199\u3002";
      if (c === "TEAM_DATA_SOURCE_VERSION_CHANGED") return "\u6765\u6E90\u7248\u672C\u672A\u80FD\u9A8C\u8BC1\uFF0C\u672A\u5C55\u793A\u53EF\u80FD\u5DF2\u53D8\u5316\u7684\u6B63\u6587\u3002\u8BF7\u5728\u5B8C\u6574\u7248\u6838\u5BF9\u5386\u53F2\u7248\u672C\u3002";
      if (c === "TEAM_DATA_KEY_NOT_REPLAYABLE") return "\u5B8C\u6574 Key \u5DF2\u4E0D\u53EF\u518D\u6B21\u8BFB\u53D6\uFF0C\u8BF7\u65B0\u5EFA\u53EA\u8BFB Key \u5E76\u53CA\u65F6\u4FDD\u5B58\u3002";
      if (c === "TEAM_DATA_KEY_REVOKED") return "\u6B64 Key \u5DF2\u64A4\u9500\u6216\u5230\u671F\uFF0C\u65E0\u6CD5\u7EE7\u7EED\u590D\u5236\u6216\u67E5\u770B\u3002";
      if (c === "TEAM_DATA_SHARE_INVALID") return "\u8BF7\u586B\u5199\u7528\u9014\u540D\u79F0\uFF0C\u5E76\u9009\u62E9 1 \u81F3 365 \u5929\u7684\u6709\u6548\u671F\u3002";
      if (c === "TEAM_CLIPBOARD_UNAVAILABLE") return "\u7CFB\u7EDF\u526A\u8D34\u677F\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
      if (!team && c === "SEMANTICA_SERVICE_AUTH_FAILED") return "\u76D2\u5B50\u4E0E\u661F\u56FE\u670D\u52A1\u7684\u63A5\u5165\u9274\u6743\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u76D2\u7AEF\u661F\u56FE\u670D\u52A1\u914D\u7F6E\u3002";
      if (!team && c === "SEMANTICA_RESOURCE_FORBIDDEN") return "\u5F53\u524D\u8D26\u53F7\u65E0\u6743\u8BBF\u95EE\u6B64\u4E2A\u4EBA\u6570\u636E\u4ED3\u3002";
      if (c === "SEMANTICA_SERVICE_AUTH_FAILED") return "\u76D2\u5B50\u4E0E\u661F\u56FE\u670D\u52A1\u7684\u63A5\u5165\u9274\u6743\u5931\u8D25\uFF0C\u8BF7\u7BA1\u7406\u5458\u68C0\u67E5\u670D\u52A1\u51ED\u636E\u53CA\u56E2\u961F\u63A5\u5165\u7248\u672C\u3002";
      if (c === "SEMANTICA_RESOURCE_FORBIDDEN") return "\u661F\u56FE\u670D\u52A1\u62D2\u7EDD\u8BBF\u95EE\u5F53\u524D\u56E2\u961F\u6570\u636E\uFF0C\u8BF7\u7BA1\u7406\u5458\u68C0\u67E5\u56E2\u961F\u6570\u636E\u6743\u9650\u4E0E\u63A5\u5165\u914D\u7F6E\u3002";
      if (c === "SEMANTICA_RESOURCE_NOT_FOUND") return "\u661F\u56FE\u670D\u52A1\u672A\u627E\u5230\u6240\u8BF7\u6C42\u7684\u8D44\u6E90\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5\uFF1B\u5982\u6301\u7EED\u51FA\u73B0\uFF0C\u8BF7\u7BA1\u7406\u5458\u68C0\u67E5\u76D2\u7AEF\u63A5\u5165\u7248\u672C\u3002";
      if (c === "SEMANTICA_INVALID_REQUEST") return "\u661F\u56FE\u670D\u52A1\u672A\u63A5\u53D7\u5F53\u524D\u8BF7\u6C42\uFF0C\u8BF7\u7BA1\u7406\u5458\u68C0\u67E5\u56E2\u961F\u5BA2\u6237\u7AEF\u4E0E\u76D2\u7AEF\u63A5\u5165\u7248\u672C\u662F\u5426\u517C\u5BB9\u3002";
      return { SEMANTICA_NOT_CONFIGURED: "\u5F53\u524D\u76D2\u5B50\u5C1A\u672A\u914D\u7F6E\u661F\u56FE\u670D\u52A1\u3002", SEMANTICA_SERVICE_UNAVAILABLE: "\u661F\u56FE\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u76D2\u5B50\u670D\u52A1\u540E\u91CD\u8BD5\u3002", SEMANTICA_UPGRADE_REQUIRED: "\u5F53\u524D\u76D2\u5B50\u9700\u8981\u5347\u7EA7\u661F\u56FE\u63A5\u5165\u3002", TEAM_STARLINK_NOT_INSTALLED: "\u5C1A\u672A\u5B89\u88C5\u661F\u56FE\uFF0C\u8BF7\u5230\u201C\u5E94\u7528\u201D\u4E2D\u5B89\u88C5\u661F\u56FE\u540E\u91CD\u8BD5\u3002", APPLICATION_INSTALL_FAILED: "\u661F\u56FE\u5B89\u88C5\u672A\u5B8C\u6210\uFF0C\u8BF7\u68C0\u67E5\u5E94\u7528\u76EE\u5F55\u6743\u9650\u540E\u91CD\u8BD5\u3002", TEAM_STARLINK_PACKAGE_INVALID: "\u5185\u7F6E\u661F\u56FE\u5B89\u88C5\u6587\u4EF6\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u91CD\u65B0\u5B89\u88C5\u56E2\u961F\u5BA2\u6237\u7AEF\u3002", TEAM_STARLINK_UPGRADE_REQUIRED: "\u5F53\u524D\u661F\u56FE\u4E0D\u652F\u6301\u6570\u636E\u4ED3\u5B9A\u4F4D\uFF0C\u8BF7\u66F4\u65B0\u661F\u56FE\u3002", TEAM_STARLINK_OPEN_TIMEOUT: "\u661F\u56FE\u672A\u786E\u8BA4\u6253\u5F00\u76EE\u6807\u9875\u9762\uFF0C\u8BF7\u68C0\u67E5\u661F\u56FE\u4E2D\u7684\u8FDE\u63A5\u72B6\u6001\u540E\u91CD\u8BD5\u3002", TEAM_ADMIN_REQUIRED: "\u7BA1\u7406\u5458\u6743\u9650\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u6838\u9A8C\u56E2\u961F\u8EAB\u4EFD\u3002", SEMANTICA_ADMIN_REQUIRED: "\u5F53\u524D\u8D26\u53F7\u6CA1\u6709\u56E2\u961F\u6570\u636E\u7BA1\u7406\u6743\u9650\u3002", HOST_SESSION_EXPIRED: "\u8D26\u53F7\u6216\u76D2\u5B50\u8FDE\u63A5\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u6570\u636E\u9875\u3002", TEAM_SESSION_CHANGED: "\u8D26\u53F7\u6216\u76D2\u5B50\u8FDE\u63A5\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u64CD\u4F5C\u3002", SPACE_UPGRADE_REQUIRED: "\u5F53\u524D\u76D2\u5B50\u4E0D\u652F\u6301\u7A7A\u95F4\u8BFB\u53D6\uFF0C\u8BF7\u5347\u7EA7\u670D\u52A1\u6216\u4ECE\u672C\u5730\u5BFC\u5165\u3002", SPACE_REMOTE_FILE_CHANGED: "\u6240\u9009\u7A7A\u95F4\u6587\u4EF6\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u3002", MODEL_CLOUD_CONFIRMATION_REQUIRED: "\u8BF7\u5148\u5728\u661F\u56FE\u7684\u201C\u6A21\u578B\u4E0E\u5904\u7406\u201D\u4E2D\u786E\u8BA4\u5728\u7EBF\u6A21\u578B\u4F7F\u7528\u8303\u56F4\u3002", WAREHOUSE_BUSY: "\u6570\u636E\u4ED3\u6B63\u5728\u8FC1\u79FB\u6216\u6E05\u7406\uFF0C\u8BF7\u7B49\u5F85\u64CD\u4F5C\u5B8C\u6210\u3002" }[c] || "\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u68C0\u67E5\u8FDE\u63A5\u3001\u5904\u7406\u4EFB\u52A1\u6216\u661F\u56FE\u914D\u7F6E\u540E\u91CD\u8BD5\u3002";
    };
    const call = async (action2, input = {}) => unwrapMaterialResponse(await request("data." + action2, input));
    const current = () => graphWarehouse();
    const activeId = () => warehouseId || overviewWarehouseId;
    const composition = createGraphComposition(() => JSON.stringify([scope, activeId()]));
    const badge = (v) => `<span class="data-status ${v === "failed" ? "failed" : v === "active" || v === "succeeded" ? "ready" : ""}">${esc4(names[v] || v || "\u5F85\u5904\u7406")}</span>`;
    const size = (v) => v >= 1024 * 1024 ? (v / 1024 / 1024).toFixed(1) + " MB" : Math.ceil((v || 0) / 1024) + " KB";
    const loc = (v) => {
      if (!v) return "\u6765\u6E90\u7247\u6BB5";
      if (typeof v === "string") {
        try {
          v = JSON.parse(v);
        } catch {
          return v;
        }
      }
      return [v.page_number || v.page ? `\u7B2C ${v.page_number || v.page} \u9875` : "", v.sheet || v.sheet_name || "", v.paragraph_number ? `\u6BB5\u843D ${v.paragraph_number}` : "", v.start_seconds != null ? `${v.start_seconds} \u79D2` : "", v.segment_id || ""].filter(Boolean).join(" \xB7 ") || "\u539F\u6587\u7247\u6BB5";
    };
    function clearLoading() {
      if (loadingTimer !== void 0) {
        clearTimeout(loadingTimer);
        loadingTimer = void 0;
      }
    }
    function readFailure(e) {
      const text = message(e), failure = code(e);
      if (invalidScope(e)) {
        reset();
        error = text;
        errorCode = failure;
        changed();
      } else {
        error = text;
        errorCode = failure;
      }
    }
    function reset() {
      ontologyDetail = null;
      ontologyError = "";
      closeMoreMenu();
      materialBrowser.reset();
      detailSequence++;
      governanceWriting = false;
      clearTimeout(refreshTimer);
      clearLoading();
      epoch++;
      warehouses = [];
      warehouseId = null;
      overviewWarehouseId = null;
      documents = [];
      jobs = [];
      results = [];
      clearGraph();
      sharePreview = null;
      shareError = "";
      governance = null;
      governanceError = "";
      reviews = [];
      reviewTotal = 0;
      reviewsOffset = 0;
      review = null;
      proposal = null;
      panel = null;
      sourceValue = null;
      panelLoading = false;
      pendingGovernance = null;
      retrieval = null;
      loading = false;
      searching = false;
      contentReady = false;
      refreshVisible = false;
      busy = false;
      error = "";
      errorCode = "";
      initialized = false;
      query = "";
      offset = 0;
      total = 0;
      document.querySelectorAll?.("dialog[data-team-data-dialog]").forEach((d) => {
        d.close();
        d.remove();
      });
    }
    function sync(state, isAdmin, options = {}) {
      admin = isAdmin;
      recoveryScope = admin && state.canLaunchApplications ? warehouseRecoveryScope(state, edition) : null;
      const next = admin && state.canLaunchApplications ? JSON.stringify([state.account?.accountId, state.account?.clientId, state.activeDeviceId, state.dataContextId, state.dataIdentity?.profileId, state.dataIdentity?.generation]) : null;
      if (next !== scope) {
        const position = options.preserveSelection && scope && next ? { warehouseId, overviewWarehouseId, tab, query, filter, offset } : null;
        reset();
        scope = next;
        if (position) {
          ({ warehouseId, overviewWarehouseId, tab, query, filter, offset } = position);
          if (tab === "tasks" || tab === "search") panel = tab;
        }
      }
    }
    async function refresh() {
      if (!scope || !admin || loading) return;
      clearTimeout(refreshTimer);
      clearLoading();
      const version = epoch;
      refreshing = contentReady;
      loading = true;
      refreshVisible = !refreshing;
      error = "";
      errorCode = "";
      if (refreshing) loadingTimer = setTimeout(() => {
        if (version === epoch && loading) {
          refreshVisible = true;
          changed();
        }
      }, 450);
      else changed();
      try {
        const listing = await call("warehouses");
        if (version !== epoch) return;
        if (!Array.isArray(listing?.items)) throw Error("TEAM_DATA_RESPONSE_INVALID");
        warehouses = listing.items;
        initialized = true;
        if (warehouseId && !current()) {
          warehouseId = null;
          documents = [];
          jobs = [];
          clearGraph();
          results = [];
        }
        if (!warehouses.some((w) => w.id === overviewWarehouseId)) {
          overviewWarehouseId = (warehouses.find((w) => w.entity_count > 0) || warehouses[0])?.id || null;
          clearGraph();
        }
        if (warehouseId) {
          const input = { warehouseId, offset };
          const result = await call(tab === "materials" ? "documents" : tab === "tasks" ? "jobs" : tab === "graph" ? "graph" : "retrieval", input);
          if (version !== epoch) return;
          if (tab === "materials") {
            documents = result.items || result.documents || [];
            total = result.total ?? documents.length;
            if (!team) {
              try {
                const pages = await Promise.all([0, 50].map((n) => call("material-workflows", { warehouseId, offset: offset + n, limit: 50 })));
                if (version !== epoch) return;
                if (pages.some((p) => !Array.isArray(p.items))) throw Error("TEAM_DATA_RESPONSE_INVALID");
                const states = new Map(pages.flatMap((p) => p.items).map((w) => [w.document_id, w]));
                documents = documents.map((d) => ({ ...d, workflow: states.get(d.id) }));
              } catch (e) {
                if (version !== epoch) return;
                if (invalidScope(e)) throw e;
              }
            }
          } else if (tab === "tasks") {
            jobs = result.items || result.jobs || [];
            total = result.total ?? jobs.length;
          } else if (tab === "graph") {
            graph = result;
            graphError = "";
          } else retrieval = result;
          if (tab === "tasks" || tab === "search") {
            try {
              const result2 = await call("graph", { warehouseId });
              if (version !== epoch) return;
              graph = result2;
              graphError = "";
            } catch (e) {
              if (version !== epoch) return;
              if (invalidScope(e)) throw e;
              graphError = message(e);
            }
          }
        } else if (overviewWarehouseId) {
          try {
            const result = await call("graph", { warehouseId: overviewWarehouseId });
            if (version !== epoch) return;
            graph = result;
            graphError = "";
          } catch (e) {
            if (version !== epoch) return;
            if (invalidScope(e)) throw e;
            graphError = message(e);
            graph = { nodes: [], edges: [] };
            graphCache = null;
          }
        }
        contentReady = true;
        const shareWid = activeId();
        if (shareWid) {
          try {
            const detail = await call("warehouse", { id: shareWid });
            if (version !== epoch) return;
            if (detail?.id !== shareWid) throw Error("TEAM_DATA_RESPONSE_INVALID");
            ontologyDetail = detail;
            ontologyError = "";
          } catch (e) {
            if (version !== epoch) return;
            if (invalidScope(e)) throw e;
            ontologyDetail = null;
            ontologyError = "\u77E5\u8BC6\u7ED3\u6784\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5\u3002";
          }
          try {
            const value = await call("authorization-summary", { warehouseId: shareWid });
            if (version !== epoch) return;
            if (!Number.isInteger(value?.active_count)) throw Error("TEAM_DATA_RESPONSE_INVALID");
            sharePreview = { ...value, warehouseId: shareWid };
            shareError = "";
          } catch (e) {
            if (version !== epoch) return;
            if (invalidScope(e)) throw e;
            if (sharePreview?.warehouseId !== shareWid) sharePreview = null;
            shareError = message(e);
          }
          try {
            const value = governance?.warehouseId === shareWid && governance.supported === false ? governance : await call("governance-summary", { warehouseId: shareWid });
            if (version !== epoch) return;
            if (value?.supported !== false && (value?.supported !== true || !Number.isInteger(value.review_count) || !Number.isInteger(value.paused_count))) throw Error("SEMANTICA_UPGRADE_REQUIRED");
            governance = { ...value, warehouseId: shareWid };
            governanceError = value.supported === false ? "\u5F53\u524D\u670D\u52A1\u5C1A\u672A\u63D0\u4F9B\u77E5\u8BC6\u6CBB\u7406\u529F\u80FD\uFF0C\u5F85\u786E\u8BA4\u4E8B\u9879\u4E0E\u95EE\u9898\u53CD\u9988\u6682\u4E0D\u53EF\u7528\u3002" : "";
          } catch (e) {
            if (version !== epoch) return;
            if (invalidScope(e)) throw e;
            if (governance?.warehouseId !== shareWid) governance = null;
            governanceError = message(e);
          }
        } else {
          sharePreview = null;
          shareError = "";
          governance = null;
          governanceError = "";
        }
      } catch (e) {
        if (version === epoch) readFailure(e);
      } finally {
        if (version === epoch) {
          clearLoading();
          loading = false;
          refreshVisible = false;
          changed();
          if (!error && warehouses.some((w) => w.active_jobs > 0)) refreshTimer = setTimeout(() => void refresh(), 3e3);
        }
      }
    }
    function btn(label, action2, extra = "", primary = false) {
      return `<button class="button ${primary ? "primary" : ""}" data-data-action="${action2}" ${extra} ${busy ? "disabled" : ""}>${label}</button>`;
    }
    function warehouseStructure() {
      const w = current();
      if (!w) return "";
      const text = ontologyDetail?.id === w.id ? ontologySummary(ontologyDetail.current_ontology) : ontologyError || "\u6B63\u5728\u8BFB\u53D6\u77E5\u8BC6\u7ED3\u6784\u2026";
      return `<div class="data-lite-ontology" role="status"><p>${esc4(text)}</p>${ontologyError ? btn("\u5237\u65B0\u77E5\u8BC6\u7ED3\u6784", "refresh") : ""}</div>`;
    }
    function createWarehouse() {
      const creationScope = recoveryScope, version = epoch;
      let pending = warehouseJournal.read(creationScope);
      function lockFields(dialog2) {
        for (const name of ["name", "description"]) {
          const field = dialog2.querySelector(`[name="${name}"]`);
          if (field) {
            field.readOnly = Boolean(pending);
            if (pending) field.value = pending.input[name];
          }
        }
      }
      const d = dialog("\u65B0\u5EFA" + owner + "\u6570\u636E\u4ED3", `<p>\u521B\u5EFA\u540E\u4F7F\u7528\u901A\u7528\u77E5\u8BC6\u7ED3\u6784\uFF0C\u53EF\u76F4\u63A5\u4E0A\u4F20\u8D44\u6599\u3002</p>${pending ? "<p>\u6709\u5F85\u786E\u8BA4\u7684\u521B\u5EFA\u64CD\u4F5C\uFF0C\u8BF7\u6062\u590D\u539F\u8BF7\u6C42\u3002</p>" : ""}<label>\u540D\u79F0<input name="name" required maxlength="60" value="${esc4(pending?.input?.name || "")}" placeholder="\u5982\uFF1A\u4EA7\u54C1\u4E0E\u5BA2\u6237\u8D44\u6599"></label><p class="data-warehouse-name-error" role="alert"></p><label>\u8BF4\u660E<textarea name="description" maxlength="500" placeholder="\u8FD9\u4E2A\u6570\u636E\u4ED3\u5B58\u653E\u54EA\u4E9B\u8D44\u6599\uFF1F">${esc4(pending?.input?.description || "")}</textarea></label>`, async (f, dialog2) => {
        pending = warehouseJournal.read(creationScope);
        dialog2.querySelector(".data-warehouse-name-error").textContent = "";
        const fields = warehouseInput(f.get("name"), f.get("description"));
        if (pending && (pending.input.name !== fields.name || pending.input.description !== fields.description)) throw Error("WAREHOUSE_CREATION_PENDING");
        if (!pending) {
          pending = { input: { ...fields, operationId: crypto.randomUUID() } };
          warehouseJournal.write(creationScope, pending);
        }
        lockFields(dialog2);
        try {
          if (!pending.id) {
            const value = await call("create-warehouse", pending.input);
            const id3 = value?.id || value?.warehouse?.id;
            if (!id3) throw Error("TEAM_DATA_RESPONSE_INVALID");
            pending = { ...pending, id: id3 };
            warehouseJournal.write(creationScope, pending);
          }
        } catch (e) {
          const failure = code(e);
          if (["WAREHOUSE_NAME_CONFLICT", "SEMANTICA_INVALID_REQUEST"].includes(failure)) {
            warehouseJournal.clear(creationScope);
            pending = null;
            lockFields(dialog2);
            if (failure === "WAREHOUSE_NAME_CONFLICT") {
              dialog2.querySelector(".data-warehouse-name-error").textContent = message(e);
              dialog2.querySelector('[name="name"]')?.focus();
              throw e;
            }
            throw Error("WAREHOUSE_CREATION_INVALID");
          }
          if (invalidScope(e)) throw e;
          if (/CONFLICT/.test(failure)) throw Error("WAREHOUSE_CREATION_CONFLICT");
          throw Error("WAREHOUSE_CREATION_UNCERTAIN");
        }
        if (version !== epoch) throw Error("TEAM_SESSION_CHANGED");
        const detail = await call("warehouse", { id: pending.id });
        if (version !== epoch) throw Error("TEAM_SESSION_CHANGED");
        if (detail?.id !== pending.id) throw Error("TEAM_DATA_RESPONSE_INVALID");
        const listing = await call("warehouses");
        if (version !== epoch) throw Error("TEAM_SESSION_CHANGED");
        if (!Array.isArray(listing?.items) || !listing.items.some((w) => w.id === pending.id)) throw Error("TEAM_DATA_RESPONSE_INVALID");
        warehouses = listing.items;
        ontologyDetail = detail;
        ontologyError = "";
        const id2 = pending.id;
        const selected = await action("select", { id: id2, tab: "graph" });
        if (!selected || recoveryScope !== creationScope) return;
        warehouseJournal.clear(creationScope);
        dialog2.close();
      });
      lockFields(d);
      if (pending) d.querySelector("[type=submit]").textContent = "\u6062\u590D\u521B\u5EFA\u7ED3\u679C";
    }
    function empty(title, body = "") {
      return `<div class="data-empty"><span aria-hidden="true">\u25C8</span><h3>${esc4(title)}</h3><p>${esc4(body)}</p></div>`;
    }
    function authorizationFooter() {
      const w = current();
      if (!w) return "";
      const details = sharePreview?.warehouseId === w.id ? sharePreview : null;
      return `<footer class="data-lite-footer"><span><i aria-hidden="true"></i>${details ? `${details.active_count} \u4E2A\u6709\u6548\u6388\u6743${shareError ? " \xB7 \u4E0A\u6B21\u8BFB\u53D6\uFF0C\u5F85\u66F4\u65B0" : ""}` : shareError ? "\u6388\u6743\u6458\u8981\u8BFB\u53D6\u5931\u8D25" : "\u6B63\u5728\u8BFB\u53D6\u6388\u6743\u6458\u8981\u2026"}</span><span>\u8D26\u53F7\u3001\u8BBE\u5907\u4E0E\u6570\u636E\u4ED3\u8DDF\u968F\u4E07\u8C61${shareError ? btn("\u91CD\u8BD5", "refresh") : ""}</span></footer>`;
    }
    function warehouseIcon() {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>';
    }
    function warehouseSwitcher() {
      const w = current(), name = w?.name || "\u9009\u62E9\u6216\u65B0\u5EFA\u6570\u636E\u4ED3", visibility = team ? "\u56E2\u961F\u7BA1\u7406\u5458\u5171\u540C\u7EF4\u62A4" : "\u4EC5\u5F53\u524D\u8D26\u53F7\u53EF\u89C1";
      return `<button type="button" class="data-warehouse-switcher" data-data-action="warehouse-picker" aria-haspopup="dialog" aria-label="\u5207\u6362\u6570\u636E\u4ED3\uFF1A${esc4(w?.name || "\u5C1A\u672A\u9009\u62E9")}" title="${esc4(name)} \xB7 ${visibility} \xB7 \u70B9\u51FB\u5207\u6362\u6570\u636E\u4ED3"><span class="data-warehouse-switcher-icon">${warehouseIcon()}</span><span class="data-warehouse-switcher-label"><small>${owner}\u6570\u636E\u4ED3 \xB7 ${visibility}</small><strong>${esc4(name)}</strong></span><svg class="data-warehouse-switcher-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>`;
    }
    function warehouseMetrics() {
      const w = current();
      return `<section class="data-lite-metrics" aria-label="\u6574\u7406\u6982\u51B5">${[[w?.document_count ?? 0, "\u4EFD\u8D44\u6599", "materials"], [w?.entity_count ?? 0, "\u4E2A\u77E5\u8BC6\u5B9E\u4F53", "graph"], [w?.relation_count ?? w?.fact_count ?? "\u2014", "\u6761\u6709\u636E\u5173\u7CFB", "graph"], [w?.active_jobs ?? 0, "\u9879\u6B63\u5728\u6574\u7406", "tasks"]].map(([n, label, target]) => `<button data-data-action="tab" data-tab="${target}"><strong>${esc4(n)}</strong><span>${label}</span></button>`).join("")}</section>${governance?.warehouseId === w?.id && governance?.paused_count > 0 ? `<div class="data-lite-paused" role="status">${governance.paused_count} \u9879\u6574\u7406\u6B63\u5728\u7B49\u5F85\u6838\u5BF9\u3002\u8BC1\u636E\u4E0D\u8DB3\u7684\u90E8\u5206\u4FDD\u6301\u6682\u505C\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u8865\u5168\u7ED3\u8BBA\u3002</div>` : ""}`;
    }
    function warehousePicker() {
      const selected = activeId();
      const rows = () => warehouses.filter((w) => (w.name + " " + (w.description || "")).toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((w) => `<div class="data-warehouse-choice-row"><button type="button" class="data-warehouse-choice ${w.id === selected ? "active" : ""}" data-choose="${esc4(w.id)}"><span class="data-lite-folder">${warehouseIcon()}</span><span><strong>${esc4(w.name)}</strong><small>${w.document_count || 0} \u4EFD\u8D44\u6599 \xB7 ${w.entity_count || 0} \u4E2A\u5B9E\u4F53${w.active_jobs ? " \xB7 " + w.active_jobs + " \u9879\u5904\u7406\u4E2D" : ""}</small>${w.description ? `<small>${esc4(w.description)}</small>` : ""}</span><span>${w.id === selected ? "\u5F53\u524D\u4F7F\u7528" : "\u2192"}</span></button><button type="button" class="button data-warehouse-rename" data-rename-warehouse="${esc4(w.id)}" aria-label="\u91CD\u547D\u540D\u6570\u636E\u4ED3\uFF1A${esc4(w.name)}">\u91CD\u547D\u540D</button></div>`).join("") || '<p class="muted">\u672A\u627E\u5230\u5339\u914D\u7684\u6570\u636E\u4ED3\u3002</p>';
      const d = dialog("\u9009\u62E9\u6570\u636E\u4ED3", `<input type="search" class="data-lite-warehouse-filter" value="${esc4(filter)}" placeholder="\u6309\u540D\u79F0\u67E5\u627E\u6570\u636E\u4ED3" aria-label="\u6309\u540D\u79F0\u67E5\u627E\u6570\u636E\u4ED3"><div class="data-lite-warehouse-list">${rows()}</div><button type="button" class="button" data-new-warehouse>\uFF0B \u65B0\u5EFA${owner}\u6570\u636E\u4ED3</button>`, async () => {
      });
      d.querySelector("[type=submit]").hidden = true;
      d.querySelector(".data-lite-warehouse-filter").oninput = (e) => {
        filter = e.target.value;
        d.querySelector(".data-lite-warehouse-list").innerHTML = rows();
      };
      d.addEventListener("click", (e) => {
        const rename = e.target.closest("[data-rename-warehouse]");
        if (rename) {
          d.close();
          void action("rename-warehouse", { id: rename.dataset.renameWarehouse });
          return;
        }
        const b = e.target.closest("[data-choose]");
        if (b) {
          d.close();
          void action("select", { id: b.dataset.choose, tab: "graph" });
        } else if (e.target.closest("[data-new-warehouse]")) {
          d.close();
          void action("create");
        }
      });
    }
    function renameWarehouse(id2) {
      const w = warehouses.find((w2) => w2.id === id2);
      if (!w) return;
      const renameScope = recoveryScope, version = epoch;
      let pending = renameJournal.read(renameScope, id2);
      function lockFields(d2) {
        const field = d2.querySelector('[name="name"]');
        field.readOnly = Boolean(pending);
        if (pending) field.value = pending.input.name;
        d2.querySelector("[type=submit]").textContent = pending ? "\u91CD\u8BD5\u4FDD\u5B58" : "\u4FDD\u5B58\u540D\u79F0";
      }
      const d = dialog("\u91CD\u547D\u540D\u6570\u636E\u4ED3", `<p>\u4FEE\u6539\u300C${esc4(w.name)}\u300D\u7684\u540D\u79F0\uFF0C\u8D44\u6599\u548C\u77E5\u8BC6\u4ECD\u4FDD\u7559\u5728\u8FD9\u4E2A\u6570\u636E\u4ED3\u3002</p>${pending ? "<p>\u4E0A\u6B21\u4FDD\u5B58\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u91CD\u8BD5\u539F\u540D\u79F0\u3002</p>" : ""}<label>\u540D\u79F0<input name="name" required maxlength="120" value="${esc4(pending?.input.name || w.name)}" aria-describedby="data-rename-name-help"></label><small id="data-rename-name-help">\u6700\u591A 60 \u4E2A\u5B57\u7B26</small><p class="data-warehouse-name-error" role="alert"></p>`, async (f, d2) => {
        pending = renameJournal.read(renameScope, id2);
        const name = warehouseInput(f.get("name"), "").name;
        d2.querySelector(".data-warehouse-name-error").textContent = "";
        if (pending && pending.input.name !== name) throw Error("WAREHOUSE_RENAME_PENDING");
        if (!pending && name === w.name) return;
        if (!pending) {
          pending = { input: { warehouseId: id2, name, operationId: crypto.randomUUID() }, saved: false };
          renameJournal.write(renameScope, id2, pending);
        }
        lockFields(d2);
        try {
          if (!pending.saved) {
            const value = await call("rename-warehouse", pending.input);
            if (version !== epoch || renameScope !== recoveryScope) throw Error("TEAM_SESSION_CHANGED");
            if (value?.id !== id2 || value.name !== pending.input.name) throw Error("TEAM_DATA_RESPONSE_INVALID");
            pending = { ...pending, saved: true };
            renameJournal.write(renameScope, id2, pending);
          }
        } catch (e) {
          if (version !== epoch || renameScope !== recoveryScope) throw Error("TEAM_SESSION_CHANGED");
          if (["WAREHOUSE_NAME_CONFLICT", "WAREHOUSE_INVALID_NAME", "WAREHOUSE_BUSY", "SEMANTICA_UPGRADE_REQUIRED"].includes(code(e))) {
            renameJournal.clear(renameScope, id2);
            pending = null;
            lockFields(d2);
            d2.querySelector(".data-warehouse-name-error").textContent = message(e);
            d2.querySelector('[name="name"]')?.focus();
            throw e;
          }
          if (invalidScope(e)) throw e;
          if (code(e) === "OPERATION_CONFLICT") throw Error("WAREHOUSE_RENAME_CONFLICT");
          throw Error("WAREHOUSE_RENAME_UNCERTAIN");
        }
        const detail = await call("warehouse", { id: id2 });
        if (version !== epoch || renameScope !== recoveryScope) throw Error("TEAM_SESSION_CHANGED");
        if (detail?.id !== id2 || typeof detail.name !== "string") throw Error("TEAM_DATA_RESPONSE_INVALID");
        warehouses = warehouses.map((item) => item.id === id2 ? { ...item, name: detail.name } : item);
        if (ontologyDetail?.id === id2) ontologyDetail = { ...ontologyDetail, name: detail.name };
        renameJournal.clear(renameScope, id2);
        filter = "";
        changed();
      });
      lockFields(d);
      d.querySelector('[name="name"]')?.focus();
    }
    function materialPage() {
      return materialBrowser.render({ documents, total, offset, pagination: pagination(), isLoading: loading });
    }
    function pagination() {
      return total > 100 ? `<div class="data-pagination">${btn("\u4E0A\u4E00\u9875", "previous", offset ? "" : "disabled")}<span>${offset + 1}\u2013${Math.min(offset + 100, total)} / ${total}</span>${btn("\u4E0B\u4E00\u9875", "next", offset + 100 < total ? "" : "disabled")}</div>` : "";
    }
    function graphPage(hero = false) {
      const w = graphWarehouse(), labels = ontologyDetail && ontologyDetail.id === w?.id ? ontologyDetail.ontology_labels : null;
      const typeInfo = Object.assign(/* @__PURE__ */ Object.create(null), defaultTypeInfo);
      for (const n of graph.nodes || []) {
        const type = typeof n.entity_type === "string" && n.entity_type ? n.entity_type : "UNKNOWN";
        const base = typeInfo[type] || [type, "", customTypeColor(type)];
        typeInfo[type] = [Object.hasOwn(labels?.entities || {}, type) ? labels.entities[type] : base[0], base[1], base[2]];
      }
      const relationNames = Object.assign(/* @__PURE__ */ Object.create(null), defaultRelationNames, labels?.relations || {});
      const rawKey = JSON.stringify([graph, labels, showIsolated]);
      if (graphCache?.rawKey !== rawKey) {
        const raw2 = { nodes: (graph.nodes || []).map((n) => ({ ...n, id: String(n.entity_id || n.id), name: String(n.canonical_name || n.name || "\u672A\u547D\u540D\u5B9E\u4F53"), type: typeof n.entity_type === "string" && n.entity_type ? n.entity_type : "UNKNOWN" })), edges: (graph.edges || []).map((e, i) => ({ ...e, id: String(e.fact_id || e.id || i), s: String(e.subject_entity_id), t: String(e.object_entity_id), label: relationNames[e.relation_type] || e.relation_type || "\u5173\u8054", evidence: e.evidence || [] })) };
        const visible = graphVisibility(raw2, showIsolated);
        graphCache = { rawKey, raw: visible, ...describeConstellations(visible) };
      }
      const { raw, constellations, membership, counts, maxima } = graphCache;
      const activeGroup = constellations.find((group) => group.id === constellation);
      const key = JSON.stringify([graphQuery, graphType, node, activeGroup?.id]);
      if (graphCache.key !== key) {
        const overview = !activeGroup && !node && !graphQuery && graphType === "all";
        const visible = selectGraph(raw, { query: graphQuery, type: graphType, focus: node, members: node ? null : activeGroup?.members });
        graphCache.key = key;
        graphCache.value = layoutConstellations(visible, overview ? constellations : []);
      }
      const g = graphCache.value, ids = new Map(g.nodes.map((n) => [n.id, n])), selected = raw.nodes.find((n) => n.id === node), selectedEdge = raw.edges.find((e) => e.id === edge), related = selectedEdge ? [selectedEdge] : raw.edges.filter((e) => e.s === node || e.t === node), groups = /* @__PURE__ */ new Map();
      const starCounts = (id2) => `${counts.get(id2)?.relations || 0} \u6761\u6709\u636E\u5173\u7CFB \xB7 ${counts.get(id2)?.sources || 0} \u4EFD\u72EC\u7ACB\u6765\u6E90`;
      const sizeBy = { counts, max: maxima[starMetric], metric: starMetric };
      for (const e of g.edges) {
        const key2 = JSON.stringify([e.s, e.t].sort());
        if (!groups.has(key2)) groups.set(key2, []);
        groups.get(key2).push(e.id);
      }
      const bounds2 = g.nodes.length ? { left: Math.min(...g.nodes.map((n) => n.x - Math.max(n.r + 18, n.labelWidth / 2 + 18))), right: Math.max(...g.nodes.map((n) => n.x + Math.max(n.r + 18, n.labelWidth / 2 + 18))), top: Math.min(...g.nodes.map((n) => n.y - n.r - 26)), bottom: Math.max(...g.nodes.map((n) => n.y + n.r + 28 + n.lines.length * 15)) } : { left: 0, right: 800, top: 0, bottom: 540 };
      const scale = Math.max((bounds2.right - bounds2.left) / 740, (bounds2.bottom - bounds2.top) / 450, 0.6) / zoom, vw = 800 * scale, vh = 540 * scale, cx = (bounds2.left + bounds2.right) / 2, cy = (bounds2.top + bounds2.bottom) / 2;
      const facts = related.map((e) => `<article>${e.paused ? '<span class="data-status">\u5F85\u6838\u5BF9 \xB7 \u5DF2\u6682\u505C\u5BF9\u5916\u4F7F\u7528</span>' : ""}<b>${esc4(raw.nodes.find((n) => n.id === e.s)?.name)} \u2192 ${esc4(e.label)} \u2192 ${esc4(raw.nodes.find((n) => n.id === e.t)?.name)}</b>${e.evidence.map((v) => `<p>${esc4(v.excerpt)}</p><button class="text-button" data-data-action="source" data-id="${esc4(v.document_id)}" data-warehouse-id="${esc4(w?.id)}" data-version-id="${esc4(v.document_version_id || v.version_id || "")}">\u67E5\u770B\u6765\u6E90 \xB7 ${esc4(loc(v.locator_json || v.locator))}</button>`).join("") || "<p>\u5F53\u524D\u5173\u7CFB\u6682\u65E0\u53EF\u5C55\u793A\u7684\u539F\u6587\u7247\u6BB5\u3002</p>"}</article>`).join("");
      const picker = btn("\u67E5\u627E\u8BC1\u636E", "tab", 'data-tab="search"');
      const emptyText = graphError || (!initialized && loading ? "\u6B63\u5728\u8BFB\u53D6" + owner + "\u77E5\u8BC6\u56FE\u8C31\u2026" : !w ? "\u5EFA\u7ACB\u7B2C\u4E00\u5EA7" + owner + "\u6570\u636E\u4ED3\uFF0C\u8BA9\u8D44\u6599\u5F00\u59CB\u76F8\u8FDE\u3002" : !showIsolated && raw.isolatedCount > 0 && !raw.nodes.length ? "\u5F53\u524D\u56FE\u8C31\u4E2D\u6682\u65E0\u6709\u5173\u7CFB\u7684\u5B9E\u4F53\uFF0C\u53EF\u5F00\u542F\u201C\u663E\u793A\u5B64\u7ACB\u5B9E\u4F53\u201D\u67E5\u770B\u3002" : raw.nodes.length ? "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u5B9E\u4F53\uFF0C\u8BF7\u8C03\u6574\u641C\u7D22\u6216\u8FD4\u56DE\u5168\u56FE\u3002" : w.document_count > 0 ? `\u5DF2\u5BFC\u5165 ${w.document_count} \u4EFD\u6750\u6599\uFF0C\u77E5\u8BC6\u56FE\u8C31\u5C1A\u672A\u751F\u6210\u3002\u8BF7\u67E5\u770B\u77E5\u8BC6\u62BD\u53D6\u4E0E\u56FE\u8C31\u5199\u5165\u7684\u5904\u7406\u7ED3\u679C\u3002` : "\u8FD9\u4E2A\u4ED3\u7684\u77E5\u8BC6\u56FE\u8C31\uFF0C\u4ECE\u7B2C\u4E00\u4EFD\u8D44\u6599\u5F00\u59CB\u3002\u5BFC\u5165\u540E\uFF0C\u5904\u7406\u6A21\u578B\u4F1A\u63D0\u53D6\u5B9E\u4F53\u4E0E\u5173\u7CFB\u3002");
      graphMotion.schedule(g, JSON.stringify([scope, activeId()]), sizeBy);
      return `<section class="data-core-graph ${hero ? "is-hero" : ""}" aria-label="\u6838\u5FC3\u77E5\u8BC6\u56FE\u8C31">
      <header class="data-core-heading"><div><h3>\u77E5\u8BC6\u56FE\u8C31</h3><p>${esc4(w?.name || owner + "\u77E5\u8BC6\u4ECE\u8FD9\u91CC\u5F00\u59CB")}</p></div><div class="data-core-actions">${picker}</div></header>
      <div class="data-core-toolbar">
        <form data-data-form="graph-search" data-data-context="${esc4(JSON.stringify([scope, activeId()]))}"><input data-studio-edit-key="team-data-graph-query" name="graphQuery" value="${esc4(graphQuery)}" placeholder="\u67E5\u627E\u5B9E\u4F53\uFF0C\u63A2\u7D22\u77E5\u8BC6\u5173\u8054" aria-label="\u67E5\u627E\u56FE\u8C31\u5B9E\u4F53"><button class="button">\u67E5\u627E</button></form>
        <div class="data-graph-filters" aria-label="\u56FE\u8C31\u5B9E\u4F53\u7C7B\u578B">${Object.entries(typeInfo).filter(([t]) => raw.nodes.some((n) => n.type === t)).map(([t, info]) => `<button data-data-action="graph-type" data-type="${esc4(t)}" aria-pressed="${graphType === t}" class="${graphType === t ? "active" : ""}">${info[2] ? `<i style="background:${info[2]}"></i>` : ""}${esc4(info[0])}</button>`).join("")}</div>
        ${node || activeGroup || graphQuery || graphType !== "all" ? btn("\u8FD4\u56DE\u5168\u56FE", "graph-reset") : ""}
        <div class="data-graph-display">${(graph.nodes || []).length ? `<button type="button" class="data-isolated-switch" data-data-action="graph-isolated" role="switch" aria-checked="${showIsolated}" ${busy ? "disabled" : ""}><span>\u663E\u793A\u5B64\u7ACB\u5B9E\u4F53</span><span class="data-isolated-switch-track" aria-hidden="true"></span></button>` : ""}</div>
        ${raw.nodes.length ? `<div class="data-space-metrics" role="group" aria-label="\u661F\u70B9\u5927\u5C0F"><span>\u661F\u70B9\u5927\u5C0F</span>${[["relations", "\u6709\u636E\u5173\u7CFB"], ["sources", "\u72EC\u7ACB\u6765\u6E90"]].map(([metric, label]) => btn(label, "graph-metric", `data-metric="${metric}" aria-pressed="${starMetric === metric}"`)).join("")}</div>` : ""}
      </div>
      <div class="data-core-body">
        <div class="data-core-canvas">
          <svg class="data-graph data-space-graph ${selected ? "is-entity-focus" : ""}" viewBox="${cx - vw / 2} ${cy - vh / 2} ${vw} ${vh}" role="group" aria-label="${esc4(w?.name || owner + "\u6570\u636E\u4ED3")}\u77E5\u8BC6\u56FE\u8C31\uFF0C\u7ACB\u4F53\u89C6\u56FE">
            <defs>
              <marker id="team-graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M1 1 L5 3.5 L1 6" fill="none" stroke="#aa987e" stroke-width=".8"/></marker>
              ${Object.entries(typeInfo).map(([type, info]) => `<radialGradient id="data-star-glow-${esc4(encodeURIComponent(type))}" class="data-star-glow" style="--type-color:${info[2]}"><stop offset="0%" stop-opacity=".32"/><stop offset="45%" stop-opacity=".16"/><stop offset="100%" stop-opacity="0"/></radialGradient>`).join("")}
            </defs>
            <g class="data-space-floor" aria-hidden="true"></g>
            <g class="data-space-links">${g.edges.map((e) => {
        const a = ids.get(e.s), b = ids.get(e.t);
        const group = groups.get(JSON.stringify([e.s, e.t].sort()));
        const path = edgeGeometry(a, b, group.indexOf(e.id), group.length), chosen = e.id === edge;
        return `<g class="data-graph-link ${chosen ? "chosen" : ""} ${e.paused ? "is-paused" : ""} ${g.anchors && membership.get(e.s) !== membership.get(e.t) ? "is-constellation-bridge" : ""}">
                <title>${esc4(a.name)} \u2192 ${esc4(e.label)} \u2192 ${esc4(b.name)}</title>
                <path class="data-edge-hit" d="${path.d}" data-data-action="edge" data-id="${esc4(e.id)}" role="button" tabindex="0" aria-label="\u67E5\u770B\u5173\u7CFB ${esc4(a.name + " " + e.label + " " + b.name)}"/>
                <path class="data-edge" d="${path.d}" marker-end="url(#team-graph-arrow)"/>
                ${chosen || selected || !g.anchors && g.edges.length <= 8 ? `<text class="data-edge-label" transform="translate(${path.x} ${path.y})" text-anchor="middle" y="-7">${esc4(e.label)}</text>` : ""}
              </g>`;
      }).join("")}</g>
            <g class="data-space-nodes">${g.nodes.map((n) => `<g class="data-core-node ${n.id === node ? "selected" : ""} ${n.paused ? "is-paused" : ""}" style="--type-color:${typeInfo[n.type][2]}" transform="translate(${n.x} ${n.y})" role="button" tabindex="0" data-data-action="node" data-id="${esc4(n.id)}" aria-label="\u67E5\u770B\u5B9E\u4F53 ${esc4(n.name)}">
              <title>${esc4(n.name)} \xB7 ${esc4(typeInfo[n.type][0])} \xB7 ${starCounts(n.id)}${n.paused ? " \xB7 \u5F85\u6838\u5BF9\uFF0C\u5DF2\u6682\u505C\u5BF9\u5916\u4F7F\u7528" : ""}</title>
              <circle class="node-star-hit" r="12"/>
              <circle class="node-star-glow" r="15" style="fill:url(#data-star-glow-${esc4(encodeURIComponent(n.type))})"/>
              <circle class="node-star" r="7"/>
              <text class="node-name" y="${n.r + 14}">${n.lines.map((line, i) => `<tspan x="0" dy="${i ? 15 : 0}">${esc4(line)}</tspan>`).join("")}</text>
            </g>`).join("")}</g>
            <g class="data-space-constellations">${(g.anchors || []).map((group) => {
        const label = labelLines(group.name)[0];
        const short = label === group.name ? label : label + "\u2026";
        const width = short.length * 12 + 20;
        return `<g class="data-space-constellation" data-data-action="graph-constellation" data-id="${esc4(group.id)}" role="button" tabindex="0" aria-label="\u67E5\u770B${esc4(group.name)}\uFF0C${group.members.size} \u4E2A\u5B9E\u4F53" transform="translate(${group.x} ${group.y})"><title>${esc4(group.name)} \xB7 ${group.members.size} \u4E2A\u5B9E\u4F53</title><rect x="${-width / 2}" y="-12" width="${width}" height="24" rx="8"/><text text-anchor="middle" dy=".34em">${esc4(short)}</text></g>`;
      }).join("")}</g>
          </svg>
          ${g.nodes.length ? `<span class="data-space-caption"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7l5.4 3.1v6.4L8 14.3l-5.4-3.1V4.8L8 1.7Zm0 6.2v6.4m0-6.4 5.4-3.1M8 7.9 2.6 4.8"/></svg>\u7ACB\u4F53\u89C6\u56FE</span>` : ""}
          ${!g.nodes.length ? `<div class="data-core-empty" ${graphError ? 'role="alert"' : ""}><span aria-hidden="true">\u25C8</span><p>${esc4(emptyText)}</p>${graphError ? btn("\u91CD\u65B0\u8BFB\u53D6", "refresh") : w && !(graph.nodes || []).length && (!loading || contentReady) ? btn(w.document_count > 0 ? "\u67E5\u770B\u5904\u7406\u4EFB\u52A1" : "\u5BFC\u5165\u8D44\u6599", w.document_count > 0 ? "tab" : "import", w.document_count > 0 ? 'data-tab="tasks"' : "") : ""}</div>` : ""}
          <div class="data-core-tools">
            ${g.nodes.length ? `<div class="data-space-rotate" aria-label="\u65CB\u8F6C\u77E5\u8BC6\u56FE\u8C31">${btn("\u21B6", "graph-rotate", 'data-direction="left" aria-label="\u5411\u5DE6\u65CB\u8F6C\u77E5\u8BC6\u56FE\u8C31" title="\u5411\u5DE6\u65CB\u8F6C"')}${btn("\u21B7", "graph-rotate", 'data-direction="right" aria-label="\u5411\u53F3\u65CB\u8F6C\u77E5\u8BC6\u56FE\u8C31" title="\u5411\u53F3\u65CB\u8F6C"')}</div>` : ""}
            ${btn("\u2212", "graph-zoom", 'data-direction="out" aria-label="\u7F29\u5C0F\u77E5\u8BC6\u56FE\u8C31"')}<output>${Math.round(zoom * 100)}%</output>${btn("\uFF0B", "graph-zoom", 'data-direction="in" aria-label="\u653E\u5927\u77E5\u8BC6\u56FE\u8C31"')}${btn("\u9002\u5E94\u753B\u5E03", "graph-fit")}
          </div>
          ${g.nodes.length ? '<p class="data-core-hint">\u62D6\u52A8\u7A7A\u767D\u5904\u65CB\u8F6C \xB7 \u6EDA\u8F6E\u7F29\u653E \xB7 \u70B9\u51FB\u67E5\u770B\u8BC1\u636E</p>' : ""}
        </div>
        <aside class="data-graph-evidence">
          <p class="data-detail-eyebrow">${selectedEdge ? "\u5173\u7CFB\u8BC1\u636E" : selected ? esc4(typeInfo[selected.type][0]) : "\u63A2\u7D22\u77E5\u8BC6"}</p>
          <h3>${esc4(selectedEdge ? "\u67E5\u770B\u5173\u7CFB\u6765\u6E90" : selected?.name || activeGroup?.name || (g.anchors ? "\u63A2\u7D22\u77E5\u8BC6\u661F\u5EA7" : "\u4ECE\u4E00\u4E2A\u5B9E\u4F53\u5F00\u59CB"))}</h3>
          ${selected && !selectedEdge ? `<p class="data-star-counts">${starCounts(selected.id)}</p>` : ""}
          ${(selectedEdge || selected)?.paused ? '<p class="data-lite-paused-note">\u5F85\u6838\u5BF9 \xB7 \u5DF2\u6682\u505C\u6B64\u77E5\u8BC6\u53CA\u5176\u4F9D\u8D56\u5173\u7CFB\u5BF9\u5916\u4F7F\u7528\u3002\u539F\u59CB\u8D44\u6599\u548C\u8BC1\u636E\u4FDD\u7559\u3002</p>' : ""}
          ${selected || selectedEdge ? (facts || "<p>\u5F53\u524D\u5B9E\u4F53\u6682\u65E0\u53EF\u5C55\u793A\u7684\u5173\u7CFB\u8BC1\u636E\u3002</p>") + ((selectedEdge || selected)?.governance_review_id ? btn("\u67E5\u770B\u5F85\u6838\u5BF9\u4E8B\u9879", "review-detail", `data-id="${esc4((selectedEdge || selected).governance_review_id)}"`) : btn("\u8FD9\u6761\u77E5\u8BC6\u6709\u95EE\u9898", "flag", `data-kind="${selectedEdge ? "relation" : "entity"}" data-id="${esc4(selectedEdge?.id || selected?.id)}"`)) : `
            <p>${g.anchors ? "\u70B9\u51FB\u5206\u7EC4\u5C55\u5F00\uFF0C\u6216\u653E\u5927\u67E5\u770B\u66F4\u591A\u5B9E\u4F53\u540D\u79F0\u3002" : `\u70B9\u51FB\u56FE\u4E2D\u5B9E\u4F53\uFF0C\u63A2\u7D22\u5B83\u4E0E${owner}\u77E5\u8BC6\u7684\u8054\u7CFB\u3002`}</p>
            <div class="data-graph-starts">${g.anchors ? g.anchors.map((group) => `<button data-data-action="graph-constellation" data-id="${esc4(group.id)}"><span>${esc4(group.name)}<small>${group.members.size} \u4E2A\u5B9E\u4F53</small></span><span>\u2192</span></button>`).join("") : g.nodes.filter((n) => n.degree > 0).slice(0, 4).map((n) => `<button data-data-action="node" data-id="${esc4(n.id)}"><span>${esc4(n.name)}<small>${esc4(typeInfo[n.type][0])} \xB7 ${n.degree} \u6761\u5173\u8054</small></span><span>\u2192</span></button>`).join("")}</div>
            <p class="data-core-detail-note">\u6709\u7591\u95EE\u7684\u77E5\u8BC6\u53EF\u4EE5\u53CD\u9988\u6838\u5BF9\u3002</p>`}
        </aside>
      </div>
      <footer class="data-core-footer">${!showIsolated && raw.isolatedCount ? `<span>\u5F53\u524D\u56FE\u8C31\u5DF2\u9690\u85CF ${raw.isolatedCount} \u4E2A\u5B64\u7ACB\u5B9E\u4F53</span>` : ""}<span><b>${g.nodes.length}</b> \u4E2A\u5B9E\u4F53 <b>${g.edges.length}</b> \u6761\u5173\u7CFB <b>${new Set(g.edges.flatMap((e) => e.evidence.map((v) => v.document_id)).filter(Boolean)).size}</b> \u4EFD\u5F15\u7528\u6750\u6599</span><span>${node ? "\u5B9E\u4F53\u76F4\u63A5\u5173\u8054" : "\u5F53\u524D\u6570\u636E\u4ED3 \xB7 \u6700\u591A 120 \u4E2A\u5B9E\u4F53"}</span></footer>
    </section>`;
    }
    function searchPage() {
      return `<form class="data-search" data-data-form="search" data-data-context="${esc4(JSON.stringify([scope, activeId()]))}"><input data-studio-edit-key="team-data-search" name="query" value="${esc4(query)}" placeholder="\u9488\u5BF9\u5F53\u524D\u6570\u636E\u4ED3\uFF0C\u8F93\u5165\u4F60\u60F3\u67E5\u627E\u7684\u95EE\u9898" aria-label="\u8BC1\u636E\u68C0\u7D22\u95EE\u9898" required maxlength="2000"><button class="button primary" ${searching ? "disabled" : ""}>${searching ? "\u68C0\u7D22\u4E2D\u2026" : "\u68C0\u7D22\u8BC1\u636E"}</button></form><p class="muted">\u7ED3\u679C\u9075\u5FAA\u6570\u636E\u4ED3\u4FDD\u62A4\u89C4\u5219\uFF0C\u4FDD\u7559\u5F15\u7528\u7247\u6BB5\u4E0E\u6765\u6E90\u5B9A\u4F4D\u3002</p>${results.map((r) => `<article class="data-search-result"><div><strong>${esc4(r.document_name || r.original_name || r.document_id)}</strong><small>${esc4(loc(r.locator))}</small></div><p>${esc4(r.text || r.excerpt)}</p><button class="text-button" data-data-action="source" data-id="${esc4(r.document_id)}" data-version-id="${esc4(r.document_version_id || r.version_id || "")}">\u67E5\u770B\u539F\u6587\u6765\u6E90 \u2192</button></article>`).join("")}${!results.length && !searching && (!loading || contentReady) ? empty(query ? "\u672A\u627E\u5230\u53EF\u4EA4\u4ED8\u7684\u8BC1\u636E" : "\u5E26\u7740\u5177\u4F53\u95EE\u9898\u67E5\u627E" + owner + "\u77E5\u8BC6", "\u5982\u6750\u6599\u5C1A\u672A\u5B8C\u6210\u7D22\u5F15\u6216\u4FDD\u62A4\u68C0\u6D4B\uFF0C\u8BF7\u5728\u661F\u56FE\u4E2D\u67E5\u770B\u5904\u7406\u72B6\u6001\u3002") : ""}`;
    }
    const failedPublications = () => jobs.filter((j) => j.kind === "knowledge_publish" && j.status === "failed");
    function failedExtractions() {
      const latest = /* @__PURE__ */ new Map();
      for (const job of jobs) {
        if (job.kind !== "knowledge_extract" || !job.document_id) continue;
        const old = latest.get(job.document_id);
        if (!old || String(job.created_at || "") > String(old.created_at || "")) latest.set(job.document_id, job);
      }
      return [...latest.values()].filter((j) => j.status === "failed" && j.error_code !== "STALE_EXTRACTION_GENERATION");
    }
    function taskPage() {
      return `${failedExtractions().length ? `<div class="data-section-heading"><p>${failedExtractions().length} \u4EFD\u6750\u6599\u7684\u6700\u65B0\u77E5\u8BC6\u62BD\u53D6\u672A\u5B8C\u6210\u3002\u539F\u4EFB\u52A1\u91CD\u8BD5\u4FDD\u7559\u65E7\u6A21\u578B\uFF1B\u4E5F\u53EF\u786E\u8BA4\u540E\u4F7F\u7528\u5F53\u524D\u6570\u636E\u4ED3\u6A21\u578B\u91CD\u65B0\u5904\u7406\u3002</p>${btn("\u7528\u5F53\u524D\u6A21\u578B\u8865\u5904\u7406\uFF08" + failedExtractions().length + "\uFF09", "reprocess-failed")}</div>` : ""}${failedPublications().length ? `<div class="data-section-heading"><p>${failedPublications().length} \u4EFD\u6750\u6599\u5DF2\u5B8C\u6210\u62BD\u53D6\uFF0C\u4F46\u56FE\u8C31\u5199\u5165\u5931\u8D25\uFF1B\u6062\u590D\u56FE\u6570\u636E\u5E93\u540E\u53EF\u91CD\u8BD5\uFF0C\u65E0\u9700\u518D\u6B21\u8C03\u7528\u62BD\u53D6\u6A21\u578B\u3002</p>${btn("\u91CD\u8BD5\u56FE\u8C31\u5199\u5165\uFF08" + failedPublications().length + "\uFF09", "retry-publications")}</div>` : ""}${jobs.map((j) => `<article class="data-task"><div><strong>${esc4(j.document_name || j.document_id || "\u6570\u636E\u4ED3\u5904\u7406\u4EFB\u52A1")}</strong><p>${esc4(jobNames[j.kind] || j.kind)} \xB7 ${esc4(stageNames[j.stage] || j.stage)}${j.total_units ? " \xB7 " + j.completed_units + "/" + j.total_units : ""}</p>${j.error_message ? `<p class="data-error-text">${esc4(j.error_message)}</p>` : ""}${j.kind === "ontology_suggest" && (j.status === "failed" || j.status === "cancelled") ? "<p>\u672C\u4F53\u5EFA\u8BAE\u4E0D\u80FD\u5728\u4EFB\u52A1\u5217\u8868\u76F4\u63A5\u91CD\u8BD5\uFF0C\u8BF7\u8FD4\u56DE\u539F\u5EFA\u8BAE\u5165\u53E3\u91CD\u65B0\u751F\u6210\uFF1B\u81EA\u52A8\u5BFC\u5165\u89E6\u53D1\u7684\u4EFB\u52A1\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u91CD\u65B0\u53D1\u8D77\u3002</p>" : ""}</div><div>${badge(j.status)}${j.kind !== "ontology_suggest" && (j.status === "failed" || j.status === "cancelled") && !["STALE_EXTRACTION_GENERATION", "SUPERSEDED", "INDEX_CHANGED"].includes(j.error_code) ? btn("\u91CD\u8BD5", "retry", `data-id="${esc4(j.id)}"`) : ""}</div></article>`).join("")}${!jobs.length && (!loading || contentReady) ? empty("\u6682\u65E0\u5904\u7406\u4EFB\u52A1", "\u5BFC\u5165\u6750\u6599\u540E\uFF0C\u4EFB\u52A1\u8FDB\u5EA6\u4F1A\u663E\u793A\u5728\u8FD9\u91CC\u3002") : ""}${pagination()}`;
    }
    function syncStatus() {
      const failure = error || shareError;
      const state = searching ? "searching" : loading && refreshVisible ? refreshing ? "refreshing" : "loading" : failure ? "error" : contentReady ? "ready" : "idle";
      const label = { searching: "\u6B63\u5728\u68C0\u7D22", loading: "\u6B63\u5728\u52A0\u8F7D", refreshing: "\u6B63\u5728\u66F4\u65B0", ready: "\u5DF2\u540C\u6B65", error: "\u66F4\u65B0\u5931\u8D25", idle: "\u51C6\u5907\u8BFB\u53D6" }[state];
      const description = state === "loading" ? "\u6B63\u5728\u8BFB\u53D6\u5F53\u524D" + owner + "\u7684\u6570\u636E\u2026" : state === "error" ? failure : label;
      return `<div class="data-sync-status" data-state="${state}" role="status" aria-live="${state === "loading" || state === "searching" || state === "error" ? "polite" : "off"}" aria-label="${esc4(description)}" title="${esc4(description)}"><span class="data-sync-dot" aria-hidden="true"></span><span>${label}</span>${state === "error" && contentReady ? '<button type="button" class="data-sync-retry" data-data-action="refresh" aria-label="\u91CD\u65B0\u8BFB\u53D6\u5F53\u524D\u6570\u636E">\u91CD\u8BD5</button>' : ""}</div>`;
    }
    const moreMenu = () => document.querySelector?.("details[data-starlink-more]");
    function closeMoreMenu() {
      const menu = moreMenu();
      if (menu) menu.open = false;
    }
    function keepMoreMenu() {
      const menu = moreMenu();
      if (!menu) return "";
      const focused = document.activeElement;
      if (menu.contains(focused)) queueMicrotask(() => {
        const replacement = moreMenu();
        if (!replacement || replacement === menu || document.activeElement !== document.body) return;
        const control = [...replacement.querySelectorAll("[data-data-action]")].find((el) => el.dataset.dataAction === focused.dataset.dataAction && !el.disabled);
        (control || replacement.querySelector("summary"))?.focus({ preventScroll: true });
      });
      return menu.open ? " open" : "";
    }
    function pageBar(target = {}, available = true) {
      return `<header class="data-page-bar${team ? "" : " wanx-section-banner"}" ${team ? "" : 'data-section="starlink"'}><div class="data-page-title"><span class="data-page-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 9L23 7 24 23 8 24 8 9 24 23M8 24L23 7"/><circle cx="8" cy="9" r="3"/><circle cx="23" cy="7" r="3"/><circle cx="24" cy="23" r="3"/><circle cx="8" cy="24" r="3"/></svg></span><div><h2>\u4E07\u8C61\u661F\u56FE <small class="data-edition-label">\u7CBE\u7B80\u7248</small> <span class="${team ? "" : "wanx-section-english"}">STARLINK</span></h2><p>\u628A\u8D44\u6599\u4EA4\u7ED9 AI\uFF0C\u8BA9\u77E5\u8BC6\u81EA\u52A8\u76F8\u8FDE\u3002</p></div></div><div class="data-page-actions">${available ? syncStatus() + btn("\uFF0B \u5BFC\u5165\u8D44\u6599", "import", current() ? "" : "disabled", true) + `<details class="wanx-action-menu" data-wanx-actions data-starlink-more${keepMoreMenu()}><summary class="button" data-data-action="toggle-more" aria-label="\u661F\u56FE\u66F4\u591A\u64CD\u4F5C">\u66F4\u591A <span aria-hidden="true">\u22EF</span></summary><div class="wanx-menu-panel" role="group" aria-label="\u661F\u56FE\u64CD\u4F5C">${btn("\u6253\u5F00\u5B8C\u6574\u7248", "open", `data-view="${target.warehouseId ? target.view : "warehouses"}" ${target.warehouseId ? `data-warehouse-id="${esc4(target.warehouseId)}"` : ""} ${busy ? "disabled" : ""}`)}${btn("\u5237\u65B0", "refresh", loading ? "disabled" : "")}${target.warehouseId ? btn("\u91CD\u547D\u540D\u6570\u636E\u4ED3", "rename-warehouse") : ""}${team && target.warehouseId ? btn("\u52A9\u7406\u6388\u6743", "assistant-access", `data-warehouse-id="${esc4(target.warehouseId)}"`) : ""}</div></details>` : ""}</div></header>`;
    }
    function sourcePanel() {
      if (panelLoading) return '<p role="status">\u6B63\u5728\u8BFB\u53D6\u6765\u6E90\u2026</p>';
      if (!sourceValue) return "<p>\u6765\u6E90\u8BFB\u53D6\u672A\u5B8C\u6210\uFF0C\u8BF7\u91CD\u8BD5\u3002</p>";
      const v = sourceValue;
      return `<p class="data-detail-eyebrow">${v.pinned ? "\u56FA\u5B9A\u7248\u672C\u539F\u6587" : "\u5F53\u524D\u6B63\u6587 \xB7 \u672A\u5B9A\u4F4D\u5386\u53F2\u7248\u672C"}</p><h3>${esc4(v.document?.original_name || "\u8D44\u6599\u6765\u6E90")}</h3><small>\u7248\u672C ${esc4(v.version?.id || v.document?.active_version_id || "\u5F85\u89E3\u6790")}</small>${v.pinned && Number.isInteger(v.total_chars) ? `<p class="muted">\u6B63\u6587\u8303\u56F4 ${v.start || 0}\u2013${v.end || 0} / ${v.total_chars} \u5B57</p>` : ""}${v.excerpt ? `<blockquote>${esc4(v.excerpt)}</blockquote>` : ""}<div class="data-source">${(v.segments || []).map((s) => `<article><small>${esc4(loc(s.source_locator || s.locator))}</small><p>${esc4(s.text || s.content)}</p></article>`).join("") || "<p>\u6B63\u6587\u5C1A\u672A\u5C31\u7EEA\uFF0C\u6216\u6B64\u7248\u672C\u4E0D\u652F\u6301\u8BFB\u53D6\u3002\u53EF\u5728\u5B8C\u6574\u7248\u67E5\u770B\u539F\u4EF6\u548C\u5904\u7406\u72B6\u6001\u3002</p>"}</div>${v.pinned && v.end < v.total_chars ? btn("\u7EE7\u7EED\u8BFB\u53D6\u6B63\u6587", "source", `data-id="${esc4(v.sourceId)}" data-warehouse-id="${esc4(v.warehouseId)}" data-version-id="${esc4(v.version.id)}" data-start="${v.end}"`) : ""}`;
    }
    function reviewPage() {
      if (governance?.warehouseId === activeId() && governance.supported === false) return `<h3>\u77E5\u8BC6\u6CBB\u7406\u6682\u4E0D\u53EF\u7528</h3><p role="status">${esc4(governanceError)}</p><p>\u4ECD\u53EF\u67E5\u770B\u8D44\u6599\u548C\u56FE\u8C31\u3002\u670D\u52A1\u5347\u7EA7\u540E\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u8D44\u6599\u9875\u3002</p>`;
      if (panelLoading) return '<p role="status">\u6B63\u5728\u8BFB\u53D6\u5F85\u786E\u8BA4\u4E8B\u9879\u2026</p>';
      if (review) {
        return `${btn("\u2190 \u5168\u90E8\u5F85\u786E\u8BA4", "reviews")}<p class="data-detail-eyebrow">${esc4(review.kind)}</p><h3>${esc4(review.title)}</h3><p>${esc4(review.description)}</p><div class="data-review-evidence">${(review.evidence || []).map((v) => `<blockquote>${esc4(v.excerpt)}</blockquote><button class="text-button" data-data-action="source" data-id="${esc4(v.document_id)}" data-version-id="${esc4(v.document_version_id || "")}">\u67E5\u770B\u8BC1\u636E\u6765\u6E90 \xB7 ${esc4(loc(v.locator))}</button>`).join("") || "<p>\u5F53\u524D\u4E8B\u9879\u6CA1\u6709\u53EF\u6838\u5BF9\u7684\u8BC1\u636E\uFF0C\u4E0D\u80FD\u636E\u6B64\u8865\u5168\u7ED3\u8BBA\u3002</p>"}</div>${proposal ? `<section class="data-lite-proposal"><h4>${proposal.status === "ready" ? "\u5EFA\u8BAE\u4FEE\u6539 \xB7 \u5C1A\u672A\u5E94\u7528" : "\u4F9D\u636E\u4E0D\u8DB3 \xB7 \u7EE7\u7EED\u5F85\u6838\u5BF9"}</h4><p>${esc4(proposal.description || "\u8BF7\u5BF9\u7167\u6765\u6E90\u6838\u5BF9\u5EFA\u8BAE\uFF0C\u786E\u8BA4\u540E\u624D\u4F1A\u5E94\u7528\u3002")}</p>${proposal.model ? `<small>\u5EFA\u8BAE\u6A21\u578B\uFF1A${esc4(typeof proposal.model === "string" ? proposal.model : proposal.model.name || proposal.model.model || proposal.model.label || "\u5DF2\u914D\u7F6E\u6A21\u578B")}</small>` : ""}<p>\u4FEE\u6539\u524D</p><pre>${esc4(JSON.stringify(proposal.before, null, 2))}</pre><p>\u4FEE\u6539\u540E</p><pre>${esc4(JSON.stringify(proposal.after, null, 2))}</pre>${(proposal.evidence || []).map((v) => `<blockquote>${esc4(v.excerpt)}</blockquote><button class="text-button" data-data-action="source" data-id="${esc4(v.document_id)}" data-version-id="${esc4(v.document_version_id || "")}">\u6838\u5BF9\u5EFA\u8BAE\u4F9D\u636E \xB7 ${esc4(loc(v.locator))}</button>`).join("")}${proposal.status === "ready" ? btn("\u786E\u8BA4\u5E94\u7528\u8FD9\u9879\u4FEE\u6539", "review-apply", "", true) : "<p>\u8BC1\u636E\u5C1A\u4E0D\u8DB3\u4EE5\u652F\u6301\u4FEE\u6539\uFF0C\u672A\u63D0\u4F9B\u5E94\u7528\u64CD\u4F5C\u3002\u53EF\u4EE5\u8865\u5145\u8D44\u6599\u6216\u4FDD\u7559\u5F85\u6838\u5BF9\u3002</p>"}${btn("\u4FDD\u7559\u539F\u7ED3\u679C", "review-discard")}</section>` : `<div class="data-lite-review-actions">${(review.actions || []).map((a) => btn(esc4(a.label), "review-resolve", `data-action-id="${esc4(a.id)}"`)).join("")}${btn("\u8BA9 AI \u5EFA\u8BAE\u5982\u4F55\u4FEE\u6539", "review-propose")}</div>`}`;
      }
      if (pendingGovernance) return "<h3>\u64CD\u4F5C\u7B49\u5F85\u786E\u8BA4</h3><p>\u5C1A\u672A\u6536\u5230\u670D\u52A1\u7AEF\u6210\u529F\u56DE\u6267\uFF0C\u5F85\u786E\u8BA4\u5217\u8868\u672A\u4F5C\u53D8\u66F4\u3002</p>";
      return `<h3>\u6709\u7591\u95EE\uFF0C\u518D\u8BF7\u4F60\u786E\u8BA4</h3><p>\u8EAB\u4EFD\u4E0D\u660E\u786E\u3001\u8BC1\u636E\u4E0D\u8DB3\u6216\u7528\u6237\u53CD\u9988\u7684\u95EE\u9898\uFF0C\u4FDD\u7559\u5F85\u6838\u5BF9\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u8865\u51FA\u7ED3\u8BBA\u3002</p>${governanceError ? `<p role="alert">${esc4(governanceError)}</p>${btn("\u91CD\u8BD5", "reviews")}` : reviews.map((v) => `<button class="data-lite-review-row" data-data-action="review-detail" data-id="${esc4(v.id)}"><strong>${esc4(v.title)}</strong><span>${esc4(v.description || v.kind)}</span><small>\u67E5\u770B\u8BC1\u636E\u4E0E\u53EF\u6267\u884C\u64CD\u4F5C \u2192</small></button>`).join("") || '<div class="data-empty"><h3>\u6CA1\u6709\u5F85\u786E\u8BA4\u4E8B\u9879</h3><p>\u5F53\u524D\u670D\u52A1\u7AEF\u5C1A\u65E0\u5F85\u786E\u8BA4\u95EE\u9898\u8BB0\u5F55\u3002</p></div>'}${reviewTotal > 50 ? `<div class="data-pagination">${btn("\u4E0A\u4E00\u9875", "reviews-page", `data-offset="${Math.max(0, reviewsOffset - 50)}" ${reviewsOffset === 0 ? "disabled" : ""}`)}<span>${reviewsOffset + 1}\u2013${Math.min(reviewsOffset + reviews.length, reviewTotal)} / ${reviewTotal}</span>${btn("\u4E0B\u4E00\u9875", "reviews-page", `data-offset="${reviewsOffset + 50}" ${reviewsOffset + 50 >= reviewTotal ? "disabled" : ""}`)}</div>` : ""}`;
    }
    function inspector() {
      if (!panel) return "";
      const title = { source: "\u77E5\u8BC6\u4E0E\u6765\u6E90", tasks: "\u6574\u7406\u8FDB\u5EA6", search: "\u67E5\u627E\u8BC1\u636E", reviews: "\u5F85\u786E\u8BA4" }[panel] || "\u77E5\u8BC6\u8BE6\u60C5";
      return `<aside class="data-lite-inspector" aria-label="${title}"><header><strong>${title}</strong>${btn("\xD7", "close-panel", 'aria-label="\u5173\u95ED\u8BE6\u60C5"')}</header><div class="data-lite-inspector-body">${error ? `<p class="data-error-text" role="alert">${esc4(error)}</p>` : ""}${panel === "source" ? sourcePanel() : panel === "tasks" ? taskPage() : panel === "search" ? searchPage() : reviewPage()}${pendingGovernance ? `<div class="data-error" role="alert">\u64CD\u4F5C\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\u3002\u91CD\u8BD5\u5C06\u4F7F\u7528\u540C\u4E00\u64CD\u4F5C\u6807\u8BC6\uFF0C\u907F\u514D\u91CD\u590D\u6267\u884C\u3002${btn("\u67E5\u8BE2\u6216\u91CD\u8BD5\u539F\u64CD\u4F5C", "governance-retry")}</div>` : ""}</div></aside>`;
    }
    function render() {
      if (!admin) return team ? empty("\u4EC5\u7BA1\u7406\u5458\u53EF\u7BA1\u7406\u56E2\u961F\u6570\u636E") : `<section class="team-data-page data-lite-page">${pageBar({}, false)}${empty("\u8BF7\u5148\u767B\u5F55\u4E07\u8C61")}</section>`;
      if (!scope) return `<section class="team-data-page data-lite-page">${pageBar({}, false)}${empty("\u8BF7\u5148\u8FDE\u63A5\u4E07\u8C61\u76D2\u5B50", "\u8FDE\u63A5\u540E\u8BFB\u53D6\u5F53\u524D" + owner + "\u7684\u6570\u636E\u4ED3\u3002")}</section>`;
      const w = current(), target = { warehouseId: w?.id, view: tab === "materials" ? "materials" : "graph" }, mainTab = tab === "materials" ? "materials" : "graph";
      return `<section class="team-data-page data-lite-page ${panel ? "has-inspector" : ""}" aria-busy="${loading || searching}">${pageBar(target)}${error && (!contentReady || team && /TEAM_STARLINK_(NOT_INSTALLED|UPGRADE_REQUIRED)/.test(errorCode)) ? `<div class="data-error" role="alert">${esc4(error)} ${team && /TEAM_STARLINK_(NOT_INSTALLED|UPGRADE_REQUIRED)/.test(errorCode) ? btn("\u5B89\u88C5\uFF0F\u66F4\u65B0\u661F\u56FE", "install-starlink") : btn("\u91CD\u8BD5", "refresh")}</div>` : ""}${warehouseMetrics()}${warehouseStructure()}<div class="data-lite-toolbar"><div class="data-lite-context">${warehouseSwitcher()}<nav class="data-tabs" aria-label="\u77E5\u8BC6\u89C6\u56FE">${tabs.map(([id2, label]) => `<button class="${mainTab === id2 ? "active" : ""}" data-data-action="tab" data-tab="${id2}" ${mainTab === id2 ? 'aria-current="page"' : ""}>${label}</button>`).join("")}</nav></div><div>${btn("\u67E5\u627E\u77E5\u8BC6\u4E0E\u8BC1\u636E", "tab", 'data-tab="search"')}</div></div><div class="data-lite-workspace">${mainTab === "materials" ? materialPage() : graphPage()}${inspector()}</div>${!w && !loading ? `<div class="data-lite-create">${btn("\uFF0B \u65B0\u5EFA" + owner + "\u6570\u636E\u4ED3", "create", "", true)}<p>${team ? "\u56E2\u961F\u7BA1\u7406\u5458\u5171\u540C\u7EF4\u62A4" : "\u4EC5\u5F53\u524D\u8D26\u53F7\u53EF\u89C1"} \xB7 \u5BFC\u5165\u8D44\u6599\u540E\uFF0C\u77E5\u8BC6\u81EA\u52A8\u76F8\u8FDE\u3002</p></div>` : ""}${authorizationFooter()}</section>`;
    }
    function dialog(title, body, onSubmit) {
      const version = epoch, d = document.createElement("dialog");
      let submitting = false;
      d.dataset.teamDataDialog = "";
      d.className = "data-dialog";
      d.innerHTML = `<form><div class="data-dialog-heading"><h3>${esc4(title)}</h3><button type="button" data-close aria-label="\u5173\u95ED">\xD7</button></div>${body}<p class="data-dialog-error" role="alert"></p><div class="data-dialog-actions"><button type="button" class="button" data-close>\u53D6\u6D88</button><button type="submit" class="button primary">\u786E\u8BA4</button></div></form>`;
      document.body.append(d);
      d.showModal();
      d.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => {
        if (!submitting) d.close();
      });
      d.addEventListener?.("cancel", (e) => {
        if (submitting) e.preventDefault();
      });
      d.onclose = () => d.remove();
      d.querySelector("form").onsubmit = async (e) => {
        e.preventDefault();
        if (submitting) return;
        submitting = true;
        const b = d.querySelector("[type=submit]");
        b.disabled = true;
        d.querySelectorAll("[data-close]").forEach((c) => c.disabled = true);
        try {
          if (version !== epoch) throw Error("TEAM_SESSION_CHANGED");
          await onSubmit(new FormData(e.target), d);
          if (version !== epoch) return;
          d.close();
          await refresh();
        } catch (e2) {
          d.querySelector(".data-dialog-error").textContent = message(e2);
        } finally {
          submitting = false;
          b.disabled = false;
          d.querySelectorAll("[data-close]").forEach((c) => c.disabled = false);
        }
      };
      return d;
    }
    async function importFiles(files) {
      if (!files?.length) return;
      const version = epoch, wid = activeId();
      let processing;
      try {
        processing = await call("processing", { warehouseId: wid });
      } catch {
      }
      if (version !== epoch) return;
      const model = processing?.effective?.extraction || processing?.config?.extraction || processing?.extraction;
      const d = dialog("\u5BFC\u5165\u5230 " + current().name, `<p>\u5BFC\u5165 ${files.length} \u4EFD\u6750\u6599\uFF0C\u751F\u6210\u53EF\u8FFD\u6EAF\u7684\u6B63\u6587\u4E0E\u77E5\u8BC6\u3002${esc4(model?.model || model?.label || "\u5904\u7406\u6A21\u578B\u6CBF\u7528\u5F53\u524D\u6570\u636E\u4ED3\u914D\u7F6E\u3002")}</p><p>\u82E5\u672C\u4ED3\u914D\u7F6E\u5728\u7EBF\u6A21\u578B\uFF0C\u6B63\u6587\u7247\u6BB5\u5C06\u53D1\u9001\u5230\u5DF2\u786E\u8BA4\u7684\u6A21\u578B\u670D\u52A1\u3002\u6A21\u578B\u8C03\u6574\u4E0E\u670D\u52A1\u786E\u8BA4\u8BF7\u5728\u661F\u56FE\u4E2D\u5B8C\u6210\u3002</p><ul>${files.map((f) => `<li>${esc4(f.name)} \xB7 ${size(f.size)}</li>`).join("")}</ul><label class="data-confirm"><input type="checkbox" name="confirmed" required>\u5DF2\u786E\u8BA4\u6750\u6599\u8303\u56F4\u53CA\u672C\u4ED3\u7684\u5904\u7406\u914D\u7F6E</label><p class="data-upload-state" role="status"></p>`, async (_, dialog2) => {
        for (let i = 0; i < files.length; i++) {
          if (version !== epoch || wid !== activeId()) throw Error("TEAM_SESSION_CHANGED");
          dialog2.querySelector(".data-upload-state").textContent = `\u6B63\u5728\u5BFC\u5165 ${i + 1}/${files.length}\uFF1A${files[i].name}`;
          await call("upload", { warehouseId: wid, handle: files[i].handle });
        }
        if (version !== epoch || wid !== activeId()) throw Error("TEAM_SESSION_CHANGED");
        warehouseId = wid;
        tab = "tasks";
        panel = "tasks";
      });
      d.querySelector("[type=submit]").textContent = "\u5BFC\u5165\u5E76\u81EA\u52A8\u6574\u7406";
      d.addEventListener("close", () => {
        if (version === epoch) void call("release-files", { warehouseId: wid, handles: files.map((f) => f.handle) }).catch(() => {
        });
      });
    }
    async function spacePicker() {
      const version = epoch, wid = activeId();
      let listing, sequence = 0;
      const picks = /* @__PURE__ */ new Map();
      const d = dialog("\u4ECE\u4E07\u8C61\u7A7A\u95F4\u5BFC\u5165", `<p>\u9009\u62E9\u5F53\u524D\u8D26\u53F7\u6709\u6743\u8BFB\u53D6\u7684\u6587\u4EF6\uFF0C\u5BFC\u5165\u4E3A${owner}\u77E5\u8BC6\u6750\u6599\u3002</p><div class="data-space-breadcrumb"></div><div class="data-space-files">\u6B63\u5728\u8BFB\u53D6\u7A7A\u95F4\u2026</div>`, async () => {
        if (version !== epoch || wid !== activeId()) throw Error("TEAM_SESSION_CHANGED");
        if (!picks.size) return;
        const files = await call("select-space-files", { warehouseId: wid, entries: [...picks.values()] });
        d.close();
        await importFiles(files);
      });
      async function load(parent = "") {
        const seq = ++sequence;
        try {
          const v = await call("space-list", { parent });
          if (version !== epoch || seq !== sequence || !d.isConnected) return;
          listing = v;
          d.querySelector(".data-space-breadcrumb").innerHTML = `<button type="button" data-folder="">\u6839\u76EE\u5F55</button>${(v.breadcrumbs || []).map((b) => `<button type="button" data-folder="${esc4(b.id)}">/ ${esc4(b.name)}</button>`).join("")}`;
          d.querySelector(".data-space-files").innerHTML = (v.items || []).map((f) => f.kind === "folder" ? `<button type="button" class="data-space-folder" data-folder="${esc4(f.id)}">\u25B1 ${esc4(f.name)} \u2192</button>` : `<label><input type="checkbox" data-file="${esc4(f.id)}" ${picks.has(f.id) ? "checked" : ""} ${f.problem ? "disabled" : ""}>${esc4(f.name)}<small>${f.problem ? esc4(f.problem) : size(f.size)}</small></label>`).join("") || "<p>\u6B64\u6587\u4EF6\u5939\u4E3A\u7A7A\u3002</p>";
        } catch (e) {
          d.querySelector(".data-dialog-error").textContent = message(e);
        }
      }
      d.addEventListener("click", (e) => {
        const b = e.target.closest("[data-folder]");
        if (b) void load(b.dataset.folder);
      });
      d.addEventListener("change", (e) => {
        if (e.target.dataset.file) {
          const f = listing.items.find((f2) => f2.id === e.target.dataset.file);
          if (e.target.checked) picks.set(f.id, { id: f.id, digest: f.digest });
          else picks.delete(f.id);
        }
      });
      await load();
    }
    async function source(id2, wid = activeId(), versionId = "", start = 0) {
      const version = epoch, sequence = ++detailSequence;
      panel = "source";
      panelLoading = true;
      sourceValue = null;
      changed();
      try {
        const v = await call("document", { warehouseId: wid, id: id2 });
        if (version !== epoch || sequence !== detailSequence || panel !== "source") return;
        let value = { ...v, pinned: false };
        if (versionId) {
          const text = await call("document-text", { warehouseId: wid, id: id2, versionId, start });
          if (version !== epoch || sequence !== detailSequence || panel !== "source") return;
          const returned = text.version_id || text.document_version_id || text.version?.id;
          if (returned !== versionId) throw Error("TEAM_DATA_SOURCE_VERSION_CHANGED");
          value = { ...v, ...text, version: { id: versionId }, segments: text.segments || [{ text: text.text || text.content || "" }], pinned: true };
        }
        sourceValue = { ...value, sourceId: id2, warehouseId: wid };
      } finally {
        if (version === epoch && sequence === detailSequence && panel === "source") {
          panelLoading = false;
          changed();
        }
      }
    }
    async function loadReviews(id2, offset2 = 0) {
      const version = epoch, wid = activeId(), sequence = ++detailSequence;
      if (!wid) return;
      if (governance?.warehouseId === wid && governance.supported === false) {
        panel = "reviews";
        panelLoading = false;
        review = null;
        proposal = null;
        changed();
        return;
      }
      panel = "reviews";
      panelLoading = true;
      review = null;
      proposal = null;
      changed();
      try {
        const value = await call(id2 ? "governance-detail" : "governance-reviews", { warehouseId: wid, ...id2 ? { reviewId: id2 } : { offset: offset2, limit: 50 } });
        if (version !== epoch || sequence !== detailSequence || panel !== "reviews") return;
        if (id2) {
          if (!value?.id || !Array.isArray(value.actions) || !Array.isArray(value.evidence)) throw Error("TEAM_DATA_RESPONSE_INVALID");
          review = value;
        } else {
          if (!Array.isArray(value?.items)) throw Error("SEMANTICA_UPGRADE_REQUIRED");
          reviews = value.items;
          reviewTotal = value.total ?? reviews.length;
          reviewsOffset = offset2;
        }
        governanceError = "";
      } catch (e) {
        if (version === epoch && sequence === detailSequence) {
          if (invalidScope(e)) readFailure(e);
          else governanceError = message(e);
        }
      } finally {
        if (version === epoch && sequence === detailSequence && panel === "reviews") {
          panelLoading = false;
          changed();
        }
      }
    }
    async function governanceWrite(actionName, input) {
      if (governanceWriting || pendingGovernance && input.operationId !== pendingGovernance.input.operationId) throw Error("TEAM_DATA_OPERATION_UNCONFIRMED");
      const version = epoch, sequence = ++detailSequence, reviewId = input.reviewId, operation = { action: actionName, input: { warehouseId: activeId(), ...input, operationId: input.operationId || crypto.randomUUID() } };
      pendingGovernance = operation;
      governanceWriting = true;
      busy = true;
      panel = "reviews";
      changed();
      try {
        const value = await call(actionName, operation.input);
        if (version !== epoch) return;
        if (actionName === "governance-propose") {
          if (!value?.id || value.review_id !== reviewId || !Number.isInteger(value.revision) || value.revision < 1 || !["ready", "insufficient"].includes(value.status) || !Array.isArray(value.evidence)) throw Error("TEAM_DATA_RESPONSE_INVALID");
          pendingGovernance = null;
          if (sequence !== detailSequence || review?.id !== reviewId) throw Error("TEAM_DATA_REVIEW_CHANGED");
          proposal = value;
        } else {
          pendingGovernance = null;
          review = null;
          proposal = null;
          await loadReviews();
          await refresh();
        }
        changed();
      } catch (e) {
        if (version === epoch) {
          if (invalidScope(e)) readFailure(e);
          else if (code(e).startsWith("WAREHOUSE_GOVERNANCE_") && !code(e).endsWith("PROPOSAL_IN_PROGRESS")) pendingGovernance = null;
        }
        throw e;
      } finally {
        if (version === epoch) {
          governanceWriting = false;
          busy = false;
          changed();
        }
      }
    }
    async function action(name, data = {}) {
      if (!scope || !admin) return;
      if (name === "toggle-more") {
        const menu = moreMenu();
        if (menu) menu.open = !menu.open;
        return;
      }
      if (["open", "refresh", "assistant-access", "rename-warehouse"].includes(name)) closeMoreMenu();
      if (await materialBrowser.action(name, data)) return;
      if (name === "delete-material") {
        if (busy) return;
        const version2 = epoch, wid = activeId();
        if (!wid) return;
        busy = true;
        error = "";
        errorCode = "";
        changed();
        try {
          const detail = await call("document", { warehouseId: wid, id: data.id });
          if (version2 !== epoch) return;
          if (detail.document?.id !== data.id) throw Error("TEAM_DATA_RESPONSE_INVALID");
          const input = { warehouseId: wid, id: data.id, versionId: detail.version?.id || detail.document.active_version_id || null, operationId: crypto.randomUUID(), confirmed: true };
          dialog("\u5220\u9664\u6750\u6599\u53CA\u5BF9\u5E94\u77E5\u8BC6", `<p>\u5C06\u4ECE\u5F53\u524D\u6570\u636E\u4ED3\u5220\u9664\u300C${esc4(detail.document.original_name)}\u300D\u53CA\u5176\u5BF9\u5E94\u77E5\u8BC6\u3001\u539F\u6587\u4F9D\u636E\u548C\u68C0\u7D22\u7D22\u5F15\uFF0C\u5E76\u53D6\u6D88\u5C1A\u672A\u5B8C\u6210\u7684\u5904\u7406\u4EFB\u52A1\u3002</p><p>\u5176\u4ED6\u6750\u6599\u4ECD\u6709\u4F9D\u636E\u652F\u6301\u7684\u5171\u4EAB\u77E5\u8BC6\u4F1A\u4FDD\u7559\u3002\u7535\u8111\u4E0A\u7684\u539F\u59CB\u6587\u4EF6\u4E0D\u4F1A\u88AB\u5220\u9664\u3002</p><label class="data-confirm"><input type="checkbox" required>\u786E\u8BA4\u5220\u9664\u8FD9\u4EFD\u6750\u6599\u53CA\u5176\u5BF9\u5E94\u77E5\u8BC6</label>`, async () => {
            await call("delete-document", input);
            if (version2 !== epoch) return;
            materialBrowser.remove(data.id);
            clearGraph();
            panel = null;
          });
        } catch (e) {
          if (version2 === epoch) {
            error = message(e);
            errorCode = code(e);
            contentReady = false;
          }
        } finally {
          if (version2 === epoch) {
            busy = false;
            changed();
          }
        }
        return;
      }
      if (governanceWriting && ["reviews", "review-detail", "reviews-page", "close-panel", "flag", "review-discard", "review-resolve", "review-propose", "review-apply", "source", "node", "edge"].includes(name)) return;
      if (pendingGovernance && ["flag", "review-resolve", "review-propose", "review-apply"].includes(name)) {
        error = message(Error("TEAM_DATA_OPERATION_UNCONFIRMED"));
        changed();
        return;
      }
      if (name === "graph-warehouse") {
        await action("select", { id: data.id, tab: "graph" });
        return;
      }
      if (name === "create") {
        try {
          createWarehouse();
        } catch (e) {
          readFailure(e);
          contentReady = false;
          changed();
        }
        return;
      }
      if (name === "warehouse-picker") {
        warehousePicker();
        return;
      }
      if (name === "rename-warehouse") {
        try {
          renameWarehouse(data.id || activeId());
        } catch (e) {
          readFailure(e);
          changed();
        }
        return;
      }
      if (name === "close-panel") {
        detailSequence++;
        panelLoading = false;
        panel = null;
        review = null;
        proposal = null;
        changed();
        return;
      }
      if (name === "reviews" || name === "review-detail") {
        await loadReviews(name === "review-detail" ? data.id : null);
        return;
      }
      if (name === "flag") {
        if (governance?.warehouseId === activeId() && governance.supported === false) {
          error = governanceError;
          changed();
          return;
        }
        if (!["entity", "relation"].includes(data.kind) || !data.id) return;
        dialog("\u53CD\u9988\u77E5\u8BC6\u95EE\u9898", '<p>\u8BF7\u63CF\u8FF0\u4F60\u53D1\u73B0\u7684\u95EE\u9898\u3002\u53CD\u9988\u4F1A\u4FDD\u7559\u4E3A\u5F85\u6838\u5BF9\u4E8B\u9879\uFF0C\u5C1A\u672A\u786E\u8BA4\u7684\u4FEE\u6539\u4E0D\u4F1A\u76F4\u63A5\u751F\u6548\u3002</p><label>\u95EE\u9898\u8BF4\u660E<textarea name="reason" required maxlength="2000" placeholder="\u4F8B\u5982\uFF1A\u540C\u540D\u4EBA\u5458\u88AB\u6DF7\u4E3A\u4E00\u4EBA\uFF0C\u6216\u8FD9\u6761\u5173\u7CFB\u7F3A\u5C11\u539F\u6587\u4F9D\u636E\u3002"></textarea></label>', async (f) => governanceWrite("governance-flag", { kind: data.kind, targetId: data.id, reason: String(f.get("reason") || ""), expectedRevision: 0 }));
        return;
      }
      if (name === "reviews-page") {
        const offset2 = Number(data.offset);
        if (Number.isSafeInteger(offset2) && offset2 >= 0 && offset2 < reviewTotal) await loadReviews(null, offset2);
        return;
      }
      if (name === "review-discard") {
        proposal = null;
        changed();
        return;
      }
      if (name === "governance-retry") {
        if (!pendingGovernance || busy) return;
        const version2 = epoch;
        busy = true;
        try {
          await governanceWrite(pendingGovernance.action, pendingGovernance.input);
        } catch (e) {
          if (version2 === epoch) {
            error = message(e);
            changed();
          }
        } finally {
          if (version2 === epoch) busy = false;
        }
        return;
      }
      if (name === "review-resolve" || name === "review-propose" || name === "review-apply") {
        if (!review || busy) return;
        if (name === "review-apply" && (!proposal || proposal.status !== "ready")) return;
        const currentReview = review, choice = review.actions.find((a) => a.id === data.actionId);
        if (name === "review-resolve" && !choice) return;
        const title = name === "review-apply" ? "\u786E\u8BA4\u5E94\u7528\u5EFA\u8BAE\u4FEE\u6539" : name === "review-propose" ? "\u8BF4\u660E\u5E0C\u671B\u5982\u4F55\u6838\u5BF9" : choice.label;
        dialog(title, `<p>${esc4(currentReview.title)}</p>${choice?.id === "unflag" ? "<p>\u64A4\u56DE\u53CD\u9988\u540E\uFF0C\u670D\u52A1\u7AEF\u4F1A\u91CD\u65B0\u6838\u9A8C\u5E76\u6062\u590D\u53EF\u7528\u77E5\u8BC6\u3002\u8BF7\u786E\u8BA4\u5DF2\u7ECF\u6838\u5BF9\u6765\u6E90\uFF1B\u6B64\u64CD\u4F5C\u4E0D\u6539\u5199\u539F\u59CB\u8D44\u6599\u3002</p>" : ""}${name === "review-apply" ? "<p>\u4EC5\u5E94\u7528\u4E0A\u65B9\u5DF2\u5C55\u793A\u7684\u5EFA\u8BAE\uFF1B\u539F\u59CB\u8D44\u6599\u4E0E\u6765\u6E90\u4FDD\u7559\u3002</p>" : '<label>\u4F9D\u636E\u6216\u8BF4\u660E<textarea name="reason" maxlength="2000" ' + (choice?.requires_note || name === "review-propose" ? "required" : "") + ' placeholder="\u8BF4\u660E\u4F60\u6838\u5BF9\u7684\u4F9D\u636E\uFF0C\u8BC1\u636E\u4E0D\u8DB3\u65F6\u8BF7\u4FDD\u7559\u5F85\u6838\u5BF9\u3002"></textarea></label>'}`, async (f) => {
          if (review?.id !== currentReview.id) throw Error("TEAM_SESSION_CHANGED");
          const base = { reviewId: currentReview.id, expectedRevision: currentReview.revision, reason: String(f.get("reason") || "") };
          if (name === "review-propose") await governanceWrite("governance-propose", base);
          else if (name === "review-apply") await governanceWrite("governance-apply", { proposalId: proposal.id, expectedRevision: proposal.revision, confirmed: true });
          else if (choice.id === "unflag") await governanceWrite("governance-unflag", { reviewId: currentReview.id, expectedRevision: currentReview.revision });
          else await governanceWrite("governance-resolve", { ...base, actionId: choice.id });
        });
        return;
      }
      if (name === "select" || name === "overview" || name === "tab") {
        if (name === "select" && !warehouses.some((w) => w.id === data.id)) return;
        if (name === "tab" && !["graph", "materials", "tasks", "search"].includes(data.tab)) return;
        const selectionEpoch = epoch;
        await call("select-warehouse");
        if (selectionEpoch !== epoch) return;
        const switching = name !== "tab";
        detailSequence++;
        panelLoading = false;
        governanceWriting = false;
        busy = false;
        epoch++;
        loading = false;
        searching = false;
        contentReady = false;
        refreshVisible = false;
        results = [];
        error = "";
        errorCode = "";
        query = "";
        offset = 0;
        total = 0;
        if (switching) {
          ontologyDetail = null;
          ontologyError = "";
          materialBrowser.reset();
          documents = [];
          jobs = [];
          clearGraph();
          sourceValue = null;
          panel = null;
          review = null;
          proposal = null;
          governance = null;
          governanceError = "";
          pendingGovernance = null;
        }
        if (name === "select") {
          if (!warehouses.some((w) => w.id === data.id)) return;
          warehouseId = data.id;
          overviewWarehouseId = data.id;
          tab = ["tasks", "graph"].includes(data.tab) ? data.tab : "materials";
        } else if (name === "overview") {
          warehouseId = null;
          tab = "graph";
        } else {
          warehouseId = activeId();
          tab = data.tab;
        }
        if (tab === "tasks" || tab === "search") panel = tab;
        else if (!switching) panel = null;
        if (sharePreview?.warehouseId !== activeId()) {
          sharePreview = null;
          shareError = "";
        }
        changed();
        await refresh();
        return epoch === selectionEpoch + 1;
      }
      if (name === "node") {
        detailSequence++;
        panelLoading = false;
        panel = null;
        sourceValue = null;
        node = data.id;
        edge = null;
        zoom = 1;
        changed();
        return;
      }
      if (name === "edge") {
        detailSequence++;
        panelLoading = false;
        panel = null;
        sourceValue = null;
        edge = data.id;
        changed();
        return;
      }
      if (name === "graph-reset" || name === "graph-constellation") {
        if (name === "graph-constellation" && !graphCache?.constellations.some((group) => group.id === data.id)) return;
        detailSequence++;
        panelLoading = false;
        panel = null;
        sourceValue = null;
        constellation = name === "graph-constellation" ? data.id : null;
        node = null;
        edge = null;
        graphQuery = "";
        graphType = "all";
        zoom = 1;
        changed();
        return;
      }
      if (name === "graph-metric") {
        if (["relations", "sources"].includes(data.metric) && starMetric !== data.metric) {
          starMetric = data.metric;
          changed();
        }
        return;
      }
      if (name === "graph-isolated") {
        showIsolated = !showIsolated;
        node = null;
        edge = null;
        constellation = null;
        zoom = 1;
        graphMotion.reset();
        changed();
        return;
      }
      if (name === "graph-type") {
        graphType = data.type;
        node = null;
        edge = null;
        zoom = 1;
        changed();
        return;
      }
      if (name === "graph-rotate") {
        graphMotion.rotate(data.direction === "left" ? -0.32 : 0.32);
        return;
      }
      if (name === "graph-zoom") {
        if (graphMotion.zoom(data.direction === "in" ? 1.25 : 0.8)) return;
        zoom = Math.min(2.5, Math.max(0.5, zoom + (data.direction === "in" ? 0.25 : -0.25)));
        changed();
        return;
      }
      if (name === "graph-fit") {
        if (graphMotion.fit()) return;
        zoom = 1;
        changed();
        return;
      }
      if (name === "refresh") {
        await refresh();
        return;
      }
      if (name === "previous" || name === "next") {
        offset = Math.max(0, offset + (name === "next" ? 100 : -100));
        await refresh();
        return;
      }
      if (name === "source") {
        if (data.warehouseId && data.warehouseId !== activeId()) return;
        const version2 = epoch, sequence = detailSequence + 1;
        try {
          await source(data.id, data.warehouseId || activeId(), data.versionId || "", Number(data.start) || 0);
        } catch (e) {
          if (version2 === epoch && sequence === detailSequence) {
            readFailure(e);
            changed();
          }
        }
        return;
      }
      if (name === "reprocess-failed" || name === "reextract-document") {
        if (!team) {
          const ids2 = [...new Set(failedExtractions().map((j) => j.document_id).filter(Boolean))], version3 = epoch, wid2 = activeId();
          if (!wid2 || !ids2.length) return;
          const d = dialog("\u9009\u62E9\u9700\u8981\u81EA\u52A8\u5904\u7406\u7684\u6750\u6599", `<p>\u9010\u4EFD\u9884\u89C8\u5F53\u524D\u5904\u7406\u914D\u7F6E\u548C\u66FF\u6362\u5F71\u54CD\uFF0C\u518D\u786E\u8BA4\u81EA\u52A8\u5904\u7406\u3002</p>${ids2.map((id2) => `<button type="button" class="button" data-automatic-document="${esc4(id2)}">${esc4(jobs.find((j) => j.document_id === id2)?.original_name || jobs.find((j) => j.document_id === id2)?.document_name || "\u5F85\u5904\u7406\u6750\u6599")}</button>`).join("")}`, async () => {
          });
          d.querySelector("[type=submit]").hidden = true;
          d.addEventListener("click", async (event) => {
            const selected = event.target.closest("[data-automatic-document]");
            if (!selected || version3 !== epoch || wid2 !== activeId()) return;
            d.close();
            tab = "materials";
            panel = null;
            changed();
            await refresh();
            if (version3 === epoch) await materialBrowser.action("reextract-document", { id: selected.dataset.automaticDocument });
          });
          return;
        }
        if (busy) return;
        const single = name === "reextract-document";
        const version2 = epoch, wid = activeId(), ids = new Set(single ? [data.id] : failedExtractions().map((j) => j.document_id));
        if (!wid || !ids.size) return;
        busy = true;
        error = "";
        errorCode = "";
        changed();
        try {
          const processing = await call("processing", { warehouseId: wid });
          let listing;
          if (single) {
            const detail = await call("document", { warehouseId: wid, id: data.id });
            listing = { items: detail.document ? [{ ...detail.document, active_version_id: detail.version?.id || detail.document.active_version_id }] : [] };
          } else listing = await call("documents", { warehouseId: wid, offset: 0 });
          if (version2 !== epoch) return;
          const selected = (listing.items || listing.documents || []).filter((d) => d && ids.has(d.id) && d.status === "ready" && d.active_version_id);
          if (!selected.length) throw Error("TEAM_DATA_RESPONSE_INVALID");
          if (single && selected[0].active_version_id !== data.versionId) throw Error("TEAM_DATA_SOURCE_VERSION_CHANGED");
          const config = processing.effective || processing.config || processing, model = config.extraction;
          if (!model || typeof config.signature !== "string") throw Error("TEAM_DATA_RESPONSE_INVALID");
          const operationId = crypto.randomUUID();
          dialog(single ? "\u91CD\u65B0\u62BD\u53D6\u5F53\u524D\u6587\u4EF6" : "\u4F7F\u7528\u5F53\u524D\u6A21\u578B\u8865\u5904\u7406", `<p>${single ? "\u4F7F\u7528\u5F53\u524D\u6587\u4EF6\u5DF2\u89E3\u6790\u7684\u6B63\u6587\u91CD\u65B0\u62BD\u53D6\u77E5\u8BC6\uFF0C\u4E0D\u91CD\u65B0\u4E0A\u4F20\u6216\u89E3\u6790\u539F\u6587\u4EF6\u3002" : `\u4EC5\u91CD\u65B0\u5904\u7406 ${selected.length} \u4EFD\u672A\u5B8C\u6210\u77E5\u8BC6\u62BD\u53D6\u7684\u6750\u6599\uFF0C\u4FDD\u7559\u5176\u4ED6\u6750\u6599\u7684\u73B0\u6709\u56FE\u8C31\u3002`}</p><p>\u5F53\u524D\u6A21\u578B\uFF1A${esc4(model?.name || model?.model || "\u5F53\u524D\u6570\u636E\u4ED3\u5904\u7406\u6A21\u578B")}\u3002${model?.location === "external" ? "\u6B63\u6587\u7247\u6BB5\u5C06\u53D1\u9001\u5230\u5DF2\u786E\u8BA4\u7684\u5728\u7EBF\u6A21\u578B\u670D\u52A1\uFF0C\u5E76\u4EA7\u751F\u6A21\u578B\u7528\u91CF\u3002" : "\u6CBF\u7528\u5F53\u524D\u6570\u636E\u4ED3\u5DF2\u786E\u8BA4\u7684\u5904\u7406\u914D\u7F6E\u3002"}</p><ul>${selected.map((d) => `<li>${esc4(d.original_name)}</li>`).join("")}</ul><label class="data-confirm"><input type="checkbox" required>\u786E\u8BA4\u4E0A\u8FF0\u6750\u6599\u8303\u56F4\u4E0E\u5F53\u524D\u6A21\u578B</label>`, async () => {
            await call("reprocess-models", { warehouseId: wid, documents: selected.map((d) => ({ id: d.id, version_id: d.active_version_id })), expectedSignature: config.signature, operationId });
            if (single && version2 === epoch) {
              warehouseId = wid;
              tab = "tasks";
              panel = "tasks";
            }
          });
        } catch (e) {
          if (version2 === epoch) {
            error = message(e);
            errorCode = code(e);
            contentReady = false;
          }
        } finally {
          if (version2 === epoch) {
            busy = false;
            changed();
          }
        }
        return;
      }
      if (busy) return;
      const version = epoch;
      busy = true;
      error = "";
      errorCode = "";
      changed();
      try {
        if (name === "share" || name === "share-create") await call("open-starlink", { warehouseId: activeId(), view: "api" });
        else if (name === "install-starlink") {
          await call("install-starlink");
          await call("open-starlink", { warehouseId: activeId(), view: activeId() ? "graph" : "warehouses" });
        } else if (name === "open") await call("open-starlink", { warehouseId: data.warehouseId || activeId(), view: data.view || (["materials", "graph"].includes(tab) ? tab : "graph") });
        else if (name === "import") {
          if (!current()) return;
          const d = dialog("\u5BFC\u5165\u8D44\u6599", `<p>\u5BFC\u5165\u5230\u300C${esc4(current().name)}\u300D\u3002\u539F\u6587\u4EF6\u4FDD\u7559\uFF0C\u540E\u7EED\u4FEE\u6539\u4E0D\u4F1A\u81EA\u52A8\u540C\u6B65\u3002</p><div class="data-lite-import-options"><button type="button" class="button primary" data-import-space>\u4ECE\u4E07\u8C61\u7A7A\u95F4\u9009\u62E9 \u2192</button><button type="button" class="button" data-import-local>\u4ECE\u7535\u8111\u9009\u62E9 \u2192</button></div>`, async () => {
          });
          d.querySelector("[type=submit]").hidden = true;
          d.addEventListener("click", (e) => {
            if (e.target.closest("[data-import-space]")) {
              d.close();
              void action("import-space");
            } else if (e.target.closest("[data-import-local]")) {
              d.close();
              void action("import-local");
            }
          });
        } else if (name === "import-local") await importFiles(await call("select-files", { warehouseId: activeId() }));
        else if (name === "import-space") await spacePicker();
        else if (name === "retry") {
          await call("retry-job", { warehouseId: activeId(), id: data.id });
          await refresh();
        } else if (name === "retry-publications") {
          const wid = activeId(), pending = failedPublications().map((j) => j.id);
          for (const id2 of pending) {
            if (version !== epoch || !scope || !admin) return;
            await call("retry-job", { warehouseId: wid, id: id2 });
          }
          if (version === epoch) await refresh();
        }
      } catch (e) {
        if (version === epoch) {
          error = message(e);
          errorCode = code(e);
        }
      } finally {
        if (version === epoch) {
          busy = false;
          changed();
        }
      }
    }
    async function submit(kind, form) {
      if (!scope || !admin) return;
      if (kind === "material-save") {
        await materialBrowser.action("material-save", {});
        return;
      }
      if (kind === "material-filter") {
        materialBrowser.filter(form.get("materialFilter") || "");
        return;
      }
      if (!scope || !admin) return;
      if (kind === "graph-search") {
        graphQuery = String(form.get("graphQuery") || "").trim();
        constellation = null;
        node = null;
        edge = null;
        zoom = 1;
        changed();
        return;
      }
      if (kind === "filter") {
        filter = form.get("filter") || "";
        changed();
        return;
      }
      if (kind === "search") {
        if (searching) return;
        query = String(form.get("query") || "").trim();
        if (!scope || !query) return;
        const version = epoch;
        searching = true;
        results = [];
        error = "";
        errorCode = "";
        changed();
        try {
          const v = await call("search", { warehouseId: activeId(), query });
          if (version === epoch) results = v.items || v.results || [];
        } catch (e) {
          if (version === epoch) readFailure(e);
        } finally {
          if (version === epoch) {
            searching = false;
            changed();
          }
        }
      }
    }
    const materialBrowser = createMaterialBrowser({ call, changed, personal: !team, getContext: () => ({ scope, recoveryScope, warehouseId: activeId() }) });
    return { compositionStart: composition.start, compositionEnd: composition.end, isComposing: composition.active, retainInput: (root) => retainGraphInput(root, document), currentWarehouse: () => activeId(), hasMaterialDrafts: () => materialBrowser.hasDrafts(), sync, suspend() {
      closeMoreMenu();
      materialBrowser.reset();
      graphMotion.reset();
      admin = false;
      detailSequence++;
      governanceWriting = false;
      epoch++;
      clearTimeout(refreshTimer);
      clearLoading();
      loading = false;
      searching = false;
      contentReady = false;
      refreshVisible = false;
      busy = false;
      initialized = false;
      error = "";
      errorCode = "";
      sharePreview = null;
      governance = null;
      panel = null;
      sourceValue = null;
      pendingGovernance = null;
      document.querySelectorAll?.("dialog[data-team-data-dialog]").forEach((d) => {
        d.close();
        d.remove();
      });
    }, render, refresh, action, submit, input: (name, value) => {
      if (materialBrowser.input(name, value)) return;
      if (name === "query") query = value;
      if (name === "filter") filter = value;
      if (name === "graphQuery") graphQuery = value;
    }, needsLoad: () => scope && !initialized && !loading && !error };
  };
  window.createTeamDataView = wrapAssistantKnowledgeAccess(window.createTeamDataView);
})();
