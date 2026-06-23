/* ============================================================
   FastAPI 도메인 렌더러 (VZ.API)
   VZ.AL(스텝플레이어)·VZ.LA(arrowPx/tween)에 의존.
   요청/응답 카드·파이프라인·Pydantic 검증·이벤트루프(실행/대기 구분)·
   DI 트리·미들웨어 양파·커넥션 풀·JWT 토큰. 순수 함수(인자→SVG 문자열).
   외부 출처 인용 없음. ROS2 트랙 VZ.ROS 렌더러 패턴 재활용.
   ============================================================ */
(function (global) {
  'use strict';
  const VZ = global.VZ, LA = VZ.LA, clamp = VZ.clamp, fmt = VZ.fmt;
  const C = {
    req: 'var(--q)', resp: 'var(--good)', node: 'var(--q)', dep: 'var(--v)',
    run: 'var(--good)', wait: 'var(--slate)', block: 'var(--drop)', hot: 'var(--hot)',
    ok: 'var(--good)', err: 'var(--drop)', mw: 'var(--pink)', tok: 'var(--hot)',
  };
  // HTTP 메서드 색
  const METHODC = { GET: 'var(--q)', POST: 'var(--good)', PUT: 'var(--hot)', PATCH: 'var(--hot)', DELETE: 'var(--drop)' };
  // 상태코드 색
  function statusColor(code) { return code < 300 ? 'var(--good)' : code < 400 ? 'var(--q)' : code < 500 ? 'var(--hot)' : 'var(--drop)'; }

  function svg(W, H, inner, aria) {
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${aria || 'FastAPI 그림'}" style="max-width:100%;display:block;background:var(--panel-2);border:1px solid var(--line);border-radius:12px">${inner}</svg>`;
  }
  const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  // ---- 박스 ----
  function box(x, y, w, h, label, opts = {}) {
    const col = opts.color || C.node, fill = opts.fill || 'var(--panel)';
    let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="${col}" stroke-width="${opts.lw || 2}"${opts.dim ? ' opacity="0.45"' : ''}/>`;
    s += `<text x="${x + w / 2}" y="${y + (opts.sub ? h / 2 - 1 : h / 2 + 4)}" text-anchor="middle" font-size="${opts.fs || 12.5}" font-family="JetBrains Mono" font-weight="700" fill="${opts.dim ? 'var(--muted)' : 'var(--ink)'}">${label}</text>`;
    if (opts.sub) s += `<text x="${x + w / 2}" y="${y + h - 7}" text-anchor="middle" font-size="9" font-family="JetBrains Mono" fill="var(--muted)">${opts.sub}</text>`;
    return s;
  }
  function pill(cx, cy, label, opts = {}) {
    const col = opts.color || C.dep, w = Math.max(48, label.length * 7.3 + 16), h = 21;
    return `<rect x="${(cx - w / 2).toFixed(1)}" y="${cy - h / 2}" width="${w.toFixed(1)}" height="${h}" rx="10.5" fill="none" stroke="${col}" stroke-width="${opts.active ? 2.3 : 1.3}"${opts.dim ? ' opacity="0.4"' : ''}/>` +
      `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="10.5" font-family="JetBrains Mono" fill="${col}">${label}</text>`;
  }
  function edge(x1, y1, x2, y2, opts = {}) {
    const col = opts.color || 'var(--line)';
    if (opts.dash) return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${opts.lw || 1.6}" stroke-dasharray="${opts.dash}"${opts.dim ? ' opacity="0.4"' : ''}/>`;
    return LA.arrowPx(x1, y1, x2, y2, col, { lw: opts.lw || 1.8 });
  }
  function packet(x, y, opts = {}) {
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${opts.r || 5}" fill="${opts.color || C.req}"${opts.drop ? ' opacity="0.4"' : ''}/>`;
  }

  // ---- HTTP 요청 카드 ----
  function reqCard(x, y, w, method, path, opts = {}) {
    const mc = METHODC[method] || 'var(--q)'; const h = opts.h || 56;
    let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="var(--panel)" stroke="${opts.color || mc}" stroke-width="1.8"/>`;
    s += `<rect x="${x + 8}" y="${y + 8}" width="${method.length * 8.5 + 12}" height="18" rx="5" fill="${mc}"/><text x="${x + 14 + method.length * 4.25}" y="${y + 21}" fill="#0b0e14" font-size="11" font-family="JetBrains Mono" font-weight="700" text-anchor="middle">${method}</text>`;
    s += `<text x="${x + 18 + method.length * 8.5}" y="${y + 21}" fill="var(--ink)" font-size="11" font-family="JetBrains Mono">${path}</text>`;
    if (opts.sub) s += `<text x="${x + 10}" y="${y + h - 9}" fill="var(--muted)" font-size="9.5" font-family="JetBrains Mono">${opts.sub}</text>`;
    return s;
  }
  function statusBadge(cx, cy, code, label) {
    const c = statusColor(code), w = 52 + (label ? label.length * 6.5 : 0);
    return `<rect x="${cx - w / 2}" y="${cy - 12}" width="${w}" height="24" rx="6" fill="${c}" opacity="0.92"/><text x="${cx}" y="${cy + 5}" fill="#0b0e14" font-size="12" font-family="JetBrains Mono" font-weight="700" text-anchor="middle">${code}${label ? ' ' + label : ''}</text>`;
  }

  // ---- 파이프라인 스테이지 바 (라우팅→검증→의존성→핸들러→응답) ----
  function stageBar(x, y, w, stages, activeIdx, opts = {}) {
    const n = stages.length, gap = 6, sw = (w - gap * (n - 1)) / n; let s = '';
    stages.forEach((st, i) => {
      const sx = x + i * (sw + gap); const on = i === activeIdx, done = activeIdx > i;
      const col = st.color || C.dep; const fill = on ? col : done ? 'rgba(52,211,153,.12)' : 'var(--panel)';
      s += `<rect x="${sx}" y="${y}" width="${sw}" height="${opts.h || 30}" rx="7" fill="${fill}" stroke="${on ? col : done ? 'var(--good)' : 'var(--line)'}" stroke-width="${on ? 2.2 : 1.2}"/>`;
      s += `<text x="${sx + sw / 2}" y="${y + (opts.h || 30) / 2 + 4}" text-anchor="middle" font-size="${opts.fs || 10}" font-family="JetBrains Mono" font-weight="${on ? 700 : 400}" fill="${on ? '#0b0e14' : done ? 'var(--good)' : 'var(--muted)'}">${st.label}</text>`;
      if (i < n - 1) s += `<text x="${sx + sw + gap / 2}" y="${y + (opts.h || 30) / 2 + 4}" text-anchor="middle" font-size="11" fill="var(--faint)">›</text>`;
    });
    return s;
  }

  // ---- Pydantic 검증 필드 목록 ----
  function fields(x, y, list, opts = {}) {
    // list: [{name, type, ok, msg}]
    let s = ''; const rowH = opts.rowH || 26;
    list.forEach((f, i) => {
      const ry = y + i * rowH; const c = f.ok ? 'var(--good)' : 'var(--drop)';
      s += `<rect x="${x}" y="${ry}" width="${opts.w || 300}" height="${rowH - 4}" rx="6" fill="${f.ok ? 'rgba(52,211,153,.08)' : 'rgba(251,113,133,.10)'}" stroke="${c}" stroke-width="1"/>`;
      s += `<text x="${x + 10}" y="${ry + rowH / 2 + 2}" font-size="11" font-family="JetBrains Mono" fill="${c}" font-weight="700">${f.ok ? '✓' : '✗'}</text>`;
      s += `<text x="${x + 28}" y="${ry + rowH / 2 + 2}" font-size="10.5" font-family="JetBrains Mono" fill="var(--ink)">${f.name}: ${f.type}</text>`;
      if (!f.ok && f.msg) s += `<text x="${x + (opts.w || 300) - 10}" y="${ry + rowH / 2 + 2}" font-size="9" font-family="JetBrains Mono" fill="var(--drop)" text-anchor="end">${f.msg}</text>`;
    });
    return s;
  }

  // ---- 이벤트 루프 타임라인 ----
  // lanes:[label], tasks:[{lane,t0,dur,label,kind:'run'|'wait'|'block'}], tmax, playhead
  // 규칙: run(실행)=꽉찬 막대(겹치면 안 됨), wait(I/O)=빗금/반투명(겹쳐도 됨), block=빨강.
  function loop(W, H, lanes, tasks, tmax, opts = {}) {
    tmax = Math.max(1e-6, tmax);  // 0 나눗셈 방지
    const padL = opts.padL || 78, padR = 14, padT = 16, padB = 22;
    const laneH = (H - padT - padB) / Math.max(1, lanes.length);
    const xx = t => padL + (t / tmax) * (W - padL - padR);
    let s = `<defs><pattern id="apihatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--slate)" stroke-width="2" opacity="0.5"/></pattern></defs>`;
    lanes.forEach((ln, i) => {
      const y = padT + i * laneH;
      s += `<line x1="${padL}" y1="${y + laneH}" x2="${W - padR}" y2="${y + laneH}" stroke="var(--line)" opacity="0.4"/>`;
      s += `<text x="8" y="${y + laneH / 2 + 4}" font-size="10" font-family="JetBrains Mono" fill="var(--muted)">${ln}</text>`;
    });
    tasks.forEach(tk => {
      const li = lanes.indexOf(tk.lane); if (li < 0) return;
      const y = padT + li * laneH + 4, h = laneH - 8;
      const dur = Math.max(0, tk.dur || 0);  // 음수 dur 방지(애니 경계 프레임)
      const x0 = xx(tk.t0), w = Math.max(2, xx(tk.t0 + dur) - x0);
      if (tk.kind === 'wait') {
        s += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="url(#apihatch)" stroke="var(--slate)" stroke-width="1" stroke-dasharray="3 2" opacity="0.7"/>`;
        if (w > 28 && tk.label) s += `<text x="${(x0 + w / 2).toFixed(1)}" y="${(y + h / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="9" font-family="JetBrains Mono" fill="var(--muted)">${tk.label}</text>`;
      } else {
        const col = tk.kind === 'block' ? C.block : (tk.color || C.run);
        s += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${col}" opacity="0.92"/>`;
        if (w > 22 && tk.label) s += `<text x="${(x0 + w / 2).toFixed(1)}" y="${(y + h / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="9.5" font-family="JetBrains Mono" fill="#0b0e14" font-weight="700">${tk.label}</text>`;
      }
    });
    if (opts.playhead != null) { const px = xx(opts.playhead); s += `<line x1="${px}" y1="${padT}" x2="${px}" y2="${H - padB}" stroke="var(--ink)" stroke-width="1.5"/>`; }
    for (let t = 0; t <= tmax + 1e-6; t += (opts.tick || tmax / 4)) s += `<text x="${xx(t)}" y="${H - 6}" text-anchor="middle" font-size="9" font-family="JetBrains Mono" fill="var(--faint)">${fmt(t, 0)}</text>`;
    return s;
  }

  // ---- 시퀀스 다이어그램 (인증 흐름 등) ----
  function sequence(W, H, lifelines, msgs, opts = {}) {
    const topY = 30, botY = H - 12; let s = '';
    lifelines.forEach(ll => {
      s += `<rect x="${ll.x - 46}" y="6" width="92" height="22" rx="6" fill="var(--panel)" stroke="${ll.color || C.node}" stroke-width="1.6"/><text x="${ll.x}" y="21" text-anchor="middle" font-size="10.5" font-family="JetBrains Mono" fill="var(--ink)">${ll.label}</text>`;
      s += `<line x1="${ll.x}" y1="${topY}" x2="${ll.x}" y2="${botY}" stroke="var(--line)" stroke-dasharray="3 4"/>`;
    });
    const upto = opts.upto != null ? opts.upto : Infinity;
    msgs.forEach(m => {
      if (m.y > upto) return;
      const a = lifelines[m.from].x, b = lifelines[m.to].x;
      const col = m.kind === 'resp' ? C.resp : m.kind === 'err' ? C.err : m.kind === 'tok' ? C.tok : C.req;
      const dash = m.kind === 'resp' || m.kind === 'tok' ? '5 3' : null;
      s += dash ? `<line x1="${a}" y1="${m.y}" x2="${b}" y2="${m.y}" stroke="${col}" stroke-width="2" stroke-dasharray="${dash}"/>` + arrowHead(b, m.y, b > a ? 1 : -1, col) : LA.arrowPx(a, m.y, b, m.y, col, { lw: 2 });
      if (m.label) s += `<text x="${(a + b) / 2}" y="${m.y - 5}" text-anchor="middle" font-size="9.5" font-family="JetBrains Mono" fill="${col}">${m.label}</text>`;
    });
    return s;
  }
  function arrowHead(x, y, dir, col) { return `<path d="M${x} ${y} l${-7 * dir} -3.5 l0 7 Z" fill="${col}"/>`; }

  // ---- 커넥션 풀 (슬롯 + 대기 큐) ----
  function pool(x, y, size, inUse, opts = {}) {
    const sw = opts.slotW || 30, sh = opts.slotH || 26, gap = 5; let s = '';
    for (let i = 0; i < size; i++) {
      const sx = x + i * (sw + gap); const busy = i < inUse;
      s += `<rect x="${sx}" y="${y}" width="${sw}" height="${sh}" rx="5" fill="${busy ? (opts.color || C.req) : 'var(--panel)'}" stroke="${busy ? (opts.color || C.req) : 'var(--line)'}" stroke-width="1.4" opacity="${busy ? 0.9 : 1}"/>`;
      s += `<text x="${sx + sw / 2}" y="${y + sh / 2 + 4}" text-anchor="middle" font-size="10" font-family="JetBrains Mono" fill="${busy ? '#0b0e14' : 'var(--faint)'}">${busy ? '●' : '○'}</text>`;
    }
    if (opts.waiting > 0) s += `<text x="${x + size * (sw + gap) + 6}" y="${y + sh / 2 + 4}" font-size="11" font-family="JetBrains Mono" fill="${C.hot}" font-weight="700">+${opts.waiting} 대기</text>`;
    return s;
  }

  // ---- 진행바 ----
  function progress(x, y, w, frac, opts = {}) {
    const col = opts.color || C.dep;
    return `<rect x="${x}" y="${y}" width="${w}" height="10" rx="5" fill="var(--panel)" stroke="var(--line)"/><rect x="${x}" y="${y}" width="${(w * clamp(frac, 0, 1)).toFixed(1)}" height="10" rx="5" fill="${col}"/>`;
  }

  // ---- 미들웨어 양파 (동심 사각) ----
  function onion(cx, cy, layers, opts = {}) {
    // layers: [{label,color}] 바깥→안쪽. activeIdx, dir(+1 들어가는중/-1 나오는중)
    let s = ''; const n = layers.length, step = opts.step || 26;
    for (let i = 0; i < n; i++) {
      const half = (n - i) * step; const col = layers[i].color || C.mw;
      const on = i === opts.activeIdx;
      s += `<rect x="${cx - half}" y="${cy - half * 0.62}" width="${half * 2}" height="${half * 1.24}" rx="10" fill="none" stroke="${col}" stroke-width="${on ? 2.6 : 1.4}" opacity="${on ? 1 : 0.55}"/>`;
      s += `<text x="${cx}" y="${cy - half * 0.62 + 14}" text-anchor="middle" font-size="9.5" font-family="JetBrains Mono" fill="${col}" opacity="${on ? 1 : 0.7}">${layers[i].label}</text>`;
    }
    s += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="10" font-family="JetBrains Mono" fill="var(--good)" font-weight="700">${opts.core || '핸들러'}</text>`;
    return s;
  }

  // ---- JWT 토큰 (header.payload.signature) ----
  function jwt(x, y, opts = {}) {
    const parts = [['header', 'var(--q)', '알고리즘'], ['payload', 'var(--hot)', '내용(공개)'], ['signature', 'var(--good)', '서명(검증)']];
    const w = opts.w || 110, h = 26; let s = '';
    parts.forEach((p, i) => {
      const px = x + i * (w + 14);
      s += `<rect x="${px}" y="${y}" width="${w}" height="${h}" rx="6" fill="none" stroke="${p[1]}" stroke-width="1.6"/><text x="${px + w / 2}" y="${y + 17}" text-anchor="middle" font-size="10.5" font-family="JetBrains Mono" fill="${p[1]}" font-weight="700">${p[0]}</text>`;
      s += `<text x="${px + w / 2}" y="${y + h + 13}" text-anchor="middle" font-size="8.5" font-family="JetBrains Mono" fill="var(--muted)">${p[2]}</text>`;
      if (i < 2) s += `<text x="${px + w + 7}" y="${y + 18}" text-anchor="middle" font-size="15" font-family="JetBrains Mono" fill="var(--faint)">.</text>`;
    });
    return s;
  }

  VZ.API = { C, METHODC, statusColor, svg, lerp2, box, pill, edge, packet, reqCard, statusBadge, stageBar, fields, loop, sequence, arrowHead, pool, progress, onion, jwt };
})(window);
