(() => {
  const loginScreen = document.querySelector("#login-screen");
  const appScreen = document.querySelector("#app-screen");
  const loginForm = document.querySelector("#login-form");
  const loginError = document.querySelector("#login-error");
  const parkingGrid = document.querySelector("#parking-grid");
  const dialog = document.querySelector("#vehicle-dialog");
  const vehicleForm = document.querySelector("#vehicle-form");
  const formError = document.querySelector("#form-error");
  const locationDialog = document.querySelector("#location-dialog");
  const locationError = document.querySelector("#location-error");
  const franchiseDialog = document.querySelector("#franchise-dialog");
  const franchiseError = document.querySelector("#franchise-error");
  const statusDialog = document.querySelector("#status-dialog");
  const statusError = document.querySelector("#status-error");
  const assessmentManagerDialog = document.querySelector("#assessment-manager-dialog");
  const assessmentManagerError = document.querySelector("#assessment-manager-error");
  let lots = [];
  let vehicles = [];
  let vehicleTypes = [];
  let statuses = [];
  let assessmentFields = [];
  let damageTypes = [];
  let inspectionMarks = [];
  let selectedDamageTypeId = null;
  let inspectionIssueDrag = null;
  let suppressDamageClick = false;
  let canManage = false;
  let canManageFranchises = false;
  let activeVehicleType = "all";
  let activeStatus = "all";
  let socket;
  let dragged = null;
  let resizing = null;
  let editingLotId = null;
  let drawingLotId = null;
  let selectedMarking = null;
  let markingError = "";
  const markingColors = new Map();
  let suppressClick = false;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 401 && path !== "/api/login") showLogin();
      if (response.status === 403 &&
          body.detail === "この加盟店アカウントは一時停止中です。総本店へお問い合わせください。") {
        loginError.textContent = body.detail;
        showLogin();
      }
      throw new Error(body.detail || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }

  function showLogin() {
    appScreen.hidden = true;
    loginScreen.hidden = false;
    if (socket) socket.close();
  }

  function showBoard(username, userCanManage, userCanManageFranchises, tenantName) {
    loginScreen.hidden = true;
    appScreen.hidden = false;
    canManage = userCanManage;
    canManageFranchises = userCanManageFranchises;
    document.querySelector("#current-user").textContent = `${tenantName} · ${username}`;
    document.querySelector("#manage-locations-button").hidden = !canManage;
    document.querySelector("#add-vehicle-button").hidden = !canManage;
    document.querySelector("#manage-franchises-button").hidden = !canManageFranchises;
    document.querySelector("#manage-statuses-button").hidden = !canManage;
    connectSocket();
    loadBoard().catch(showError);
  }

  function showError(error) {
    console.error(error);
    formError.textContent = error.message;
  }

  async function loadBoard() {
    if (dragged || resizing || draftMarking) return;
    const data = await api("/api/bootstrap");
    lots = data.parking_lots;
    vehicles = data.vehicles;
    vehicleTypes = data.vehicle_types;
    statuses = data.statuses || [];
    assessmentFields = data.assessment_fields || [];
    damageTypes = data.damage_types || [];
    const availableDamageTypeIds = new Set(damageTypes.map((type) => type.id));
    inspectionMarks = inspectionMarks.filter((mark) => availableDamageTypeIds.has(mark.damage_type_id));
    if (!availableDamageTypeIds.has(selectedDamageTypeId)) selectedDamageTypeId = null;
    if (activeStatus !== "all" && !statuses.some((status) => String(status.id) === activeStatus)) {
      activeStatus = "all";
    }
    populateVehicleTypeChoices();
    render();
    if (statusDialog.open) renderStatusManager();
  }

  function typeClass(type) {
    const index = Math.max(0, vehicleTypes.indexOf(type));
    return `type-color-${index}`;
  }

  function render() {
    parkingGrid.replaceChildren();
    for (const lot of lots) {
      const inLot = vehicles.filter((vehicle) => vehicle.parking_lot_id === lot.id);
      parkingGrid.append(makeParkingCard(lot, inLot));
    }
    document.querySelector("#vehicle-count").textContent = vehicles.length;
    document.querySelector("#lot-count").textContent = lots.length;
    document.querySelector("#attention-count").textContent = vehicles.filter((vehicle) =>
      vehicle.status_ids?.length,
    ).length;
    renderVehicleCatalog(vehicles);
    renderStatusFilters();
    renderStatusList(vehicles);
    if (!dialog.open) renderInspectionDiagram();
  }

  function makeParkingCard(lot, inLot) {
    const card = document.createElement("article");
    card.className = "lot-card";
    card.dataset.lotId = lot.id;
    const heading = document.createElement("div");
    heading.className = "lot-heading";
    heading.draggable = canManage;
    heading.title = canManage ? "エリアカードをドラッグして並べ替え" : "";
    heading.addEventListener("dragstart", (event) => {
      if (!canManage) {
        event.preventDefault();
        return;
      }
      if (event.target.closest("button, a, input")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData("text/plain", String(lot.id));
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("reordering");
    });
    heading.addEventListener("dragend", () => card.classList.remove("reordering"));
    card.addEventListener("dragover", (event) => {
      if (canManage && event.dataTransfer.types.includes("text/plain")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }
    });
    card.addEventListener("drop", (event) => {
      if (!canManage) return;
      event.preventDefault();
      const sourceId = Number(event.dataTransfer.getData("text/plain"));
      if (sourceId && sourceId !== lot.id) reorderLots(sourceId, lot.id).catch(showError);
    });
    const headingTitle = lot.navigation_url
      ? document.createElement("a")
      : document.createElement("div");
    headingTitle.className = "lot-heading-title";
    if (lot.navigation_url) {
      headingTitle.href = lot.navigation_url;
      headingTitle.target = "_blank";
      headingTitle.rel = "noopener noreferrer";
      headingTitle.setAttribute("aria-label", `${lot.name}のGoogleマップナビを開く`);
      headingTitle.title = "Googleマップでナビを開く";
    }
    const title = document.createElement("h3");
    title.textContent = lot.name;
    const count = document.createElement("span");
    count.className = "lot-count";
    count.textContent = `${inLot.length} 台`;
    headingTitle.append(title, count);
    if (lot.navigation_url) {
      const navigationIcon = document.createElement("span");
      navigationIcon.className = "lot-navigation-icon";
      navigationIcon.textContent = "↗";
      navigationIcon.setAttribute("aria-hidden", "true");
      headingTitle.append(navigationIcon);
    }
    heading.append(headingTitle);
    if (canManage) {
      const controls = document.createElement("div");
      controls.className = "lot-controls";
      const resize = document.createElement("button");
      resize.type = "button";
      resize.className = "lot-control";
      resize.textContent = "サイズ調整";
      resize.title = "クリック後、右下のハンドルをドラッグしてサイズを調整";
      resize.addEventListener("click", () => {
        const nextEditingLotId = editingLotId === lot.id ? null : lot.id;
        if (nextEditingLotId !== editingLotId) drawingLotId = null;
        editingLotId = nextEditingLotId;
        selectedMarking = null;
        markingError = "";
        render();
      });
      const earlier = makeLotControl("←", "左へ移動", () => moveLot(lot.id, -1));
      const later = makeLotControl("→", "右へ移動", () => moveLot(lot.id, 1));
      resize.textContent = editingLotId === lot.id ? "完了" : "サイズ調整";
      controls.append(resize, earlier, later);
      heading.append(controls);
    }
    if (canManage && editingLotId === lot.id) card.classList.add("size-editing");
    const area = document.createElement("div");
    area.className = "lot-area";
    area.dataset.lotId = lot.id;
    area.style.height = `${Math.max(lot.area_height, Math.ceil(inLot.length / 4) * 52 + 24)}px`;
    card.style.setProperty("--lot-width", `${lot.area_width}%`);
    if (!inLot.length) area.classList.add("empty");
    const markings = Array.isArray(lot.markings) ? lot.markings : [];
    if (markings.length || editingLotId === lot.id) area.classList.remove("empty");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("lot-markings");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-label", `${lot.name}の線`);
    svg.dataset.lotId = lot.id;
    if (editingLotId === lot.id) {
      svg.classList.add("editable");
      svg.classList.toggle("drawing", drawingLotId === lot.id);
      svg.addEventListener("pointerdown", (event) => startMarking(event, lot, svg));
      svg.addEventListener("pointermove", moveMarking);
      svg.addEventListener("pointerup", (event) => endMarking(event, lot, svg));
      svg.addEventListener("pointercancel", cancelMarking);
    }
    for (const marking of markings) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.dataset.markingId = marking.id;
      line.setAttribute("x1", marking.x1 * 1000);
      line.setAttribute("y1", marking.y1 * 1000);
      line.setAttribute("x2", marking.x2 * 1000);
      line.setAttribute("y2", marking.y2 * 1000);
      line.setAttribute("stroke", marking.color);
      line.setAttribute("stroke-width", selectedMarking === marking.id ? "10" : "7");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("pointer-events", editingLotId === lot.id ? "stroke" : "none");
      if (selectedMarking === marking.id) line.classList.add("selected");
      line.addEventListener("pointerdown", (event) => {
        if (editingLotId !== lot.id || drawingLotId === lot.id) return;
        event.stopPropagation();
        selectedMarking = marking.id;
        render();
      });
      svg.append(line);
    }
    if (editingLotId === lot.id && drawingLotId === lot.id) {
      const preview = document.createElementNS("http://www.w3.org/2000/svg", "line");
      preview.classList.add("marking-preview");
      preview.setAttribute("stroke", markingColors.get(lot.id) || "#e34b4b");
      preview.setAttribute("stroke-width", "7");
      preview.setAttribute("stroke-linecap", "round");
      svg.append(preview);
    }
    area.append(svg);
    for (const vehicle of inLot) area.append(makeToken(vehicle));
    let tools;
    if (canManage && editingLotId === lot.id) {
      tools = document.createElement("div");
      tools.className = "lot-drawing-tools";
      const draw = document.createElement("button");
      draw.type = "button";
      draw.className = "lot-control";
      draw.textContent = drawingLotId === lot.id ? "描画終了" : "直線を引く";
      draw.addEventListener("click", () => {
        drawingLotId = drawingLotId === lot.id ? null : lot.id;
        selectedMarking = null;
        render();
      });
      const color = document.createElement("input");
      color.type = "color";
      color.id = `marking-color-${lot.id}`;
      color.value = markingColors.get(lot.id) || "#e34b4b";
      color.setAttribute("aria-label", "線の色");
      color.addEventListener("input", () => {
        markingColors.set(lot.id, color.value);
        const preview = card.querySelector(".marking-preview");
        if (preview) preview.setAttribute("stroke", color.value);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "選択した線を削除";
      remove.disabled = !selectedMarking;
      remove.addEventListener("click", () => {
        updateMarkings(lot, markings.filter((marking) => marking.id !== selectedMarking));
      });
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "lot-control";
      undo.textContent = "取り消し";
      undo.title = "最後に描いた線を取り消します";
      undo.disabled = markings.length === 0;
      undo.addEventListener("click", () => {
        if (!markings.length) return;
        updateMarkings(lot, markings.slice(0, -1));
      });
      tools.append(draw, color, undo, remove);
      const guidance = document.createElement("span");
      guidance.className = "lot-marking-guidance";
      guidance.textContent = drawingLotId === lot.id
        ? "位置内をドラッグして直線を引きます。"
        : "線を選択してから削除できます。";
      tools.append(guidance);
      if (markingError) {
        const error = document.createElement("span");
        error.className = "lot-marking-error";
        error.textContent = markingError;
        tools.append(error);
      }
    }
    if (canManage) {
      const resizeHandle = document.createElement("button");
      resizeHandle.type = "button";
      resizeHandle.className = "lot-resize-handle";
      resizeHandle.textContent = "◢";
      resizeHandle.setAttribute("aria-label", `${lot.name}のサイズをドラッグして調整`);
      resizeHandle.title = "ドラッグして幅と高さを調整";
      resizeHandle.addEventListener("pointerdown", (event) => startResize(event, lot, card, area));
      area.append(resizeHandle);
    }
    card.append(heading);
    if (tools) card.append(tools);
    card.append(area);
    return card;
  }

  let draftMarking = null;

  function markingPosition(event, svg) {
    const bounds = svg.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  function startMarking(event, lot, svg) {
    if (drawingLotId !== lot.id || (event.button !== 0 && event.pointerType === "mouse")) return;
    event.preventDefault();
    const point = markingPosition(event, svg);
    draftMarking = { lotId: lot.id, pointerId: event.pointerId, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
    const preview = svg.querySelector(".marking-preview");
    preview?.setAttribute("x1", point.x * 1000);
    preview?.setAttribute("y1", point.y * 1000);
    preview?.setAttribute("x2", point.x * 1000);
    preview?.setAttribute("y2", point.y * 1000);
    svg.setPointerCapture(event.pointerId);
  }

  function moveMarking(event) {
    if (!draftMarking || event.pointerId !== draftMarking.pointerId) return;
    const svg = document.querySelector(`.lot-markings[data-lot-id="${draftMarking.lotId}"]`);
    if (!svg) return;
    const point = markingPosition(event, svg);
    draftMarking.x2 = point.x;
    draftMarking.y2 = point.y;
    const preview = svg.querySelector(".marking-preview");
    if (preview) {
      preview.setAttribute("x2", point.x * 1000);
      preview.setAttribute("y2", point.y * 1000);
    }
  }

  async function endMarking(event, lot, svg) {
    if (!draftMarking || event.pointerId !== draftMarking.pointerId) return;
    moveMarking(event);
    const draft = draftMarking;
    draftMarking = null;
    const markings = Array.isArray(lot.markings) ? lot.markings : [];
    if (Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) < 0.01) {
      render();
      return;
    }
    const color = document.querySelector(`#marking-color-${lot.id}`).value;
    await updateMarkings(lot, [...markings, {
      id: crypto.randomUUID(),
      color,
      x1: draft.x1,
      y1: draft.y1,
      x2: draft.x2,
      y2: draft.y2,
    }]);
  }

  function cancelMarking(event) {
    if (draftMarking?.pointerId === event.pointerId) {
      draftMarking = null;
      document.querySelector(".marking-preview")?.removeAttribute("x1");
    }
  }

  async function updateMarkings(lot, markings) {
    try {
      const updated = await api(`/api/parking-lots/${lot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ markings }),
      });
      Object.assign(lot, updated);
      selectedMarking = null;
      markingError = "";
      render();
    } catch (error) {
      markingError = error.message;
      render();
    }
  }

  function startResize(event, lot, card, area) {
    if (event.button !== 0 || resizing) return;
    event.preventDefault();
    event.stopPropagation();
    const gridWidth = parkingGrid.getBoundingClientRect().width;
    if (!gridWidth) return;
    resizing = {
      lot,
      card,
      area,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: lot.area_width,
      height: area.getBoundingClientRect().height,
      gridWidth,
      nextWidth: lot.area_width,
      nextHeight: area.getBoundingClientRect().height,
    };
    card.classList.add("resizing");
  }

  function moveResize(event) {
    if (!resizing || event.pointerId !== resizing.pointerId) return;
    const nextWidth = Math.max(30, Math.min(100,
      Math.round(resizing.width + (event.clientX - resizing.startX) / resizing.gridWidth * 100)));
    const nextHeight = Math.max(160, Math.min(600,
      resizing.height + event.clientY - resizing.startY));
    resizing.nextWidth = nextWidth;
    resizing.nextHeight = nextHeight;
    resizing.card.style.setProperty("--lot-width", `${nextWidth}%`);
    resizing.area.style.height = `${nextHeight}px`;
  }

  async function endResize(event, cancelled = false) {
    if (!resizing || event.pointerId !== resizing.pointerId) return;
    const current = resizing;
    resizing = null;
    current.card.classList.remove("resizing");
    if (cancelled) {
      current.card.style.setProperty("--lot-width", `${current.width}%`);
      current.area.style.height = `${current.height}px`;
      return;
    }
    if (current.nextWidth === current.width && current.nextHeight === current.height) return;
    try {
      await updateLotLayout(current.lot, {
        area_width: current.nextWidth,
        area_height: Math.round(current.nextHeight),
      });
    } catch (error) {
      showError(error);
      current.card.style.setProperty("--lot-width", `${current.width}%`);
      current.area.style.height = `${current.height}px`;
    }
  }

  function makeLotControl(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lot-control layout-control";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick().catch(showError);
    });
    return button;
  }

  async function updateLotLayout(lot, changes) {
    await api(`/api/parking-lots/${lot.id}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    await loadBoard();
  }

  async function reorderLots(sourceId, targetId) {
    const ordered = lots.map((lot) => lot.id);
    const sourceIndex = ordered.indexOf(sourceId);
    if (sourceIndex < 0 || !ordered.includes(targetId)) return;
    ordered.splice(sourceIndex, 1);
    ordered.splice(ordered.indexOf(targetId), 0, sourceId);
    await saveLotOrder(ordered);
  }

  async function moveLot(lotId, direction) {
    const ordered = lots.map((lot) => lot.id);
    const index = ordered.indexOf(lotId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ordered.length) return;
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    await saveLotOrder(ordered);
  }

  async function saveLotOrder(ordered) {
    await api("/api/parking-lots/order", {
      method: "PUT",
      body: JSON.stringify({ ids: ordered }),
    });
    await loadBoard();
  }

  function makeToken(vehicle) {
    const token = document.createElement("button");
    token.type = "button";
    token.className = `vehicle-token ${typeClass(vehicle.vehicle_type)}`;
    token.dataset.id = vehicle.id;
    token.style.left = `${8 + vehicle.position_x * 84}%`;
    token.style.top = `${10 + vehicle.position_y * 80}%`;
    token.setAttribute("aria-label", `${vehicle.plate}、${vehicle.vehicle_type}`);
    const plate = document.createElement("span");
    plate.textContent = vehicle.plate;
    token.append(plate);
    const badges = [
      ...statuses.filter((status) => vehicle.status_ids?.includes(status.id)).map((status) => status.icon),
      ...(vehicle.options || []),
    ];
    if (badges.length) {
      const badgeNode = document.createElement("span");
      badgeNode.className = "token-badges";
      badgeNode.textContent = badges.join(" · ");
      token.append(badgeNode);
    }
    token.addEventListener("pointerdown", startDrag);
    token.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      openVehicle(vehicle);
    });
    return token;
  }

  function startDrag(event) {
    if (event.button !== 0 || dragged) return;
    event.preventDefault();
    const token = event.currentTarget;
    const ghost = token.cloneNode(true);
    ghost.classList.add("dragging", "drag-ghost");
    ghost.style.position = "fixed";
    ghost.style.pointerEvents = "none";
    ghost.style.width = `${token.getBoundingClientRect().width}px`;
    ghost.style.left = `${event.clientX}px`;
    ghost.style.top = `${event.clientY}px`;
    document.body.append(ghost);
    dragged = {
      id: Number(token.dataset.id),
      token,
      ghost,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
    };
    token.setPointerCapture(event.pointerId);
    dragged.scrollFrame = requestAnimationFrame(autoScrollWhileDragging);
  }

  function moveDrag(event) {
    if (!dragged || event.pointerId !== dragged.pointerId) return;
    dragged.clientX = event.clientX;
    dragged.clientY = event.clientY;
    if (Math.abs(event.clientX - dragged.startX) + Math.abs(event.clientY - dragged.startY) > 5) {
      dragged.moved = true;
    }
    if (!dragged.moved) return;
    dragged.ghost.style.left = `${event.clientX}px`;
    dragged.ghost.style.top = `${event.clientY}px`;
    updateDropTarget(event.clientX, event.clientY);
  }

  function updateDropTarget(x, y) {
    document.querySelectorAll(".lot-area.drop-target").forEach((area) => area.classList.remove("drop-target"));
    document.elementFromPoint(x, y)
      ?.closest(".lot-area")?.classList.add("drop-target");
  }

  function autoScrollWhileDragging() {
    if (!dragged) return;
    dragged.scrollFrame = requestAnimationFrame(autoScrollWhileDragging);
    if (!dragged.moved) return;
    const edgeSize = Math.min(100, window.innerHeight * 0.16);
    const y = dragged.clientY;
    let scrollDelta = 0;
    if (y < edgeSize) {
      scrollDelta = -Math.ceil(20 * (1 - y / edgeSize));
    } else if (y > window.innerHeight - edgeSize) {
      scrollDelta = Math.ceil(20 * (1 - (window.innerHeight - y) / edgeSize));
    }
    if (!scrollDelta) return;
    const previousScrollY = window.scrollY;
    window.scrollBy(0, scrollDelta);
    if (window.scrollY !== previousScrollY) {
      updateDropTarget(dragged.clientX, dragged.clientY);
    }
  }

  async function endDrag(event, cancelled = false) {
    if (!dragged || event.pointerId !== dragged.pointerId) return;
    const current = dragged;
    cancelAnimationFrame(current.scrollFrame);
    current.clientX = event.clientX;
    current.clientY = event.clientY;
    if (!cancelled && current.moved) updateDropTarget(event.clientX, event.clientY);
    const dropTarget = !cancelled && current.moved
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;
    const dropArea = dropTarget?.closest(".lot-area");
    dragged = null;
    current.ghost.remove();
    document.querySelectorAll(".lot-area.drop-target").forEach((area) => area.classList.remove("drop-target"));
    if (!current.moved) return;
    suppressClick = true;
    if (!dropArea) {
      window.setTimeout(() => { suppressClick = false; }, 0);
      return;
    }
    const rect = dropArea.getBoundingClientRect();
    const position = {
      position_x: Math.max(0, Math.min(1, (event.clientX - rect.left - rect.width * 0.08) / (rect.width * 0.84))),
      position_y: Math.max(0, Math.min(1, (event.clientY - rect.top - rect.height * 0.1) / (rect.height * 0.8))),
      parking_lot_id: Number(dropArea.dataset.lotId),
    };
    try {
      await api(`/api/vehicles/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify(position),
      });
    } catch (error) {
      showError(error);
    }
    await loadBoard();
    window.setTimeout(() => { suppressClick = false; }, 0);
  }

  document.addEventListener("pointermove", moveDrag);
  document.addEventListener("pointermove", moveResize);
  document.addEventListener("pointermove", moveInspectionIssueDrag);
  document.addEventListener("pointerup", (event) => endDrag(event));
  document.addEventListener("pointerup", (event) => endResize(event));
  document.addEventListener("pointerup", endInspectionIssueDrag);
  document.addEventListener("pointercancel", (event) => endDrag(event, true));
  document.addEventListener("pointercancel", (event) => endResize(event, true));
  document.addEventListener("pointercancel", endInspectionIssueDrag);

  function populateVehicleTypeChoices() {
    const select = vehicleForm.elements.vehicle_type;
    const current = select.value;
    select.replaceChildren(...vehicleTypes.map((type) => {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      return option;
    }));
    if (vehicleTypes.includes(current)) select.value = current;
    const filters = document.querySelector("#vehicle-type-filters");
    const active = activeVehicleType;
    filters.replaceChildren();
    for (const [value, label] of [["all", "All"], ...vehicleTypes.map((type) => [type, type])]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `type-filter${value === "all" ? "" : ` ${typeClass(value)}`}${value === active ? " active" : ""}`;
      button.dataset.vehicleType = value;
      button.textContent = label;
      button.addEventListener("click", () => {
        activeVehicleType = value;
        renderVehicleCatalog(vehicles);
      });
      filters.append(button);
    }
  }

  function renderVehicleCatalog(boardVehicles) {
    const filtered = boardVehicles.filter((vehicle) =>
      activeVehicleType === "all" || vehicle.vehicle_type === activeVehicleType,
    );
    const list = document.querySelector("#vehicle-catalog-list");
    list.replaceChildren();
    document.querySelector("#catalog-total").textContent = `${filtered.length} 台`;
    document.querySelectorAll(".type-filter").forEach((button) => {
      button.classList.toggle("active", button.dataset.vehicleType === activeVehicleType);
    });
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "該当する車両はありません。";
      list.append(empty);
      return;
    }
    for (const vehicle of filtered) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "catalog-item";
      const plate = document.createElement("strong");
      plate.textContent = vehicle.plate;
      const details = document.createElement("span");
      const lot = lots.find((entry) => entry.id === vehicle.parking_lot_id);
      details.textContent = `${vehicle.vehicle_type} · ${lot?.name || "未配置"}${vehicle.options?.length ? ` · ${vehicle.options.join("・")}` : ""}`;
      item.append(plate, details);
      item.addEventListener("click", () => {
        const location = document.querySelector(`[data-lot-id="${vehicle.parking_lot_id}"]`);
        location?.scrollIntoView({ behavior: "smooth", block: "center" });
        document.querySelector(`[data-id="${vehicle.id}"]`)?.focus({ preventScroll: true });
      });
      list.append(item);
    }
  }

  function renderStatusFilters() {
    const filters = document.querySelector("#status-filters");
    filters.replaceChildren();
    const options = [{ id: "all", label: "すべて" }, ...statuses.map((status) => ({
      id: String(status.id),
      label: `${status.icon} ${status.name}`,
    }))];
    for (const status of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `filter-button${String(activeStatus) === status.id ? " active" : ""}`;
      button.dataset.filter = status.id;
      button.textContent = status.label;
      button.addEventListener("click", () => {
        activeStatus = status.id;
        renderStatusFilters();
        renderStatusList(vehicles);
      });
      filters.append(button);
    }
  }

  function renderStatusList(boardVehicles) {
    const list = document.querySelector("#status-list");
    list.replaceChildren();
    const selectedStatusId = activeStatus === "all" ? null : Number(activeStatus);
    const filtered = boardVehicles.filter((vehicle) =>
      selectedStatusId === null || vehicle.status_ids?.includes(selectedStatusId));
    document.querySelector("#status-total").textContent = `${filtered.length} 台`;
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = activeStatus === "all" ? "登録車両はありません。「車両を追加」から登録してください。" : "該当する車両はありません。";
      list.append(empty);
      return;
    }
    for (const vehicle of filtered) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "status-item";
      const plate = document.createElement("strong");
      plate.textContent = vehicle.plate;
      const description = document.createElement("span");
      const active = statuses.filter((status) => vehicle.status_ids?.includes(status.id))
        .map((status) => `${status.icon} ${status.name}`);
      const lot = lots.find((entry) => entry.id === vehicle.parking_lot_id);
      description.textContent = `${lot?.name || "未配置"} · ${active.join(" / ") || vehicle.vehicle_type}`;
      item.append(plate, description);
      item.addEventListener("click", () => {
        document.querySelector(`[data-lot-id="${vehicle.parking_lot_id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
        document.querySelector(`[data-id="${vehicle.id}"]`)?.focus({ preventScroll: true });
      });
      list.append(item);
    }
  }

  function renderVehicleStatusOptions(vehicle) {
    const options = document.querySelector("#vehicle-status-options");
    options.replaceChildren();
    for (const status of statuses) {
      const label = document.createElement("label");
      label.className = "check-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "status_ids";
      input.value = status.id;
      input.checked = vehicle?.status_ids?.includes(status.id) || false;
      label.append(input, document.createTextNode(`${status.icon} ${status.name}`));
      options.append(label);
    }
    if (!statuses.length) {
      const empty = document.createElement("span");
      empty.className = "status-empty";
      empty.textContent = "対応ステータスはありません。";
      options.append(empty);
    }
  }

  function renderStatusManager() {
    const list = document.querySelector("#status-manager-list");
    list.replaceChildren();
    if (!statuses.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "対応ステータスはありません。";
      list.append(empty);
      return;
    }
    for (const status of statuses) {
      const row = document.createElement("div");
      row.className = "status-manager-row";
      const label = document.createElement("span");
      label.textContent = `${status.icon} ${status.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        statusError.textContent = "";
        if (!window.confirm(`ステータス「${status.name}」を削除しますか？登録済み車両からも解除されます。`)) return;
        remove.disabled = true;
        try {
          await api(`/api/statuses/${status.id}`, { method: "DELETE" });
          await loadBoard();
          renderStatusManager();
        } catch (error) {
          statusError.textContent = error.message;
          remove.disabled = false;
        }
      });
      row.append(label, remove);
      list.append(row);
    }
  }

  const assessmentGroupLabels = {
    body: "外装・内装系",
    electrical: "車検証・電装系",
    basic: "基本情報",
    custom: "追加項目",
  };

  function renderAssessmentFields(values = {}) {
    const container = document.querySelector("#assessment-fields");
    container.replaceChildren();
    const groups = ["body", "electrical", "basic", "custom"];
    for (const groupKey of groups) {
      const groupFields = assessmentFields.filter((field) => field.group_key === groupKey);
      if (!groupFields.length) continue;
      const section = document.createElement("section");
      section.className = "assessment-group";
      const heading = document.createElement("h4");
      heading.textContent = assessmentGroupLabels[groupKey];
      const grid = document.createElement("div");
      grid.className = "assessment-field-grid";
      for (const field of groupFields) {
        const row = document.createElement("div");
        row.className = "assessment-field";
        const label = document.createElement("span");
        label.textContent = field.name;
        const control = document.createElement("div");
        control.className = "assessment-field-control";
        const value = values[field.id] ?? "";
        if (field.field_type === "rating") {
          const input = document.createElement("input");
          input.type = "hidden";
          input.dataset.assessmentFieldId = field.id;
          control.append(input);
          const ratings = document.createElement("div");
          ratings.className = "rating-control";
          ratings.setAttribute("role", "group");
          ratings.setAttribute("aria-label", `${field.name}の評価`);
          for (let score = 1; score <= 5; score += 1) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = String(score);
            button.setAttribute("aria-label", `${score}点`);
            button.setAttribute("aria-pressed", String(String(value) === String(score)));
            button.classList.toggle("active", String(value) === String(score));
            button.addEventListener("click", () => {
              input.value = String(score);
              ratings.querySelectorAll("button").forEach((item) => {
                const active = item === button;
                item.classList.toggle("active", active);
                item.setAttribute("aria-pressed", String(active));
              });
            });
            ratings.append(button);
          }
          control.append(ratings);
        } else if (field.field_type === "checkbox") {
          const input = document.createElement("input");
          input.type = "checkbox";
          input.dataset.assessmentFieldId = field.id;
          input.checked = value === true || value === "true" || value === "1";
          input.setAttribute("aria-label", `${field.name}${field.suffix ? ` ${field.suffix}` : ""}`);
          control.append(input);
          if (field.suffix) {
            const suffix = document.createElement("span");
            suffix.className = "assessment-field-suffix";
            suffix.textContent = field.suffix;
            control.insertBefore(suffix, input);
          }
        } else {
          const input = document.createElement("input");
          input.type = field.field_type === "number" ? "number" : "text";
          input.dataset.assessmentFieldId = field.id;
          input.value = value;
          input.maxLength = field.field_type === "text" ? 500 : 12;
          input.setAttribute("aria-label", field.name);
          if (field.field_type === "number") {
            input.min = "0";
            input.step = "1";
            input.inputMode = "numeric";
            if (field.built_in_key === "registration_month") {
              input.min = "1";
              input.max = "12";
              input.placeholder = "1〜12";
            } else if (field.built_in_key === "registration_year") {
              input.min = "1900";
              input.max = String(new Date().getFullYear());
            }
          }
          control.append(input);
          if (field.suffix) {
            const suffix = document.createElement("span");
            suffix.className = "assessment-field-suffix";
            suffix.textContent = field.suffix;
            control.append(suffix);
          }
        }
        row.append(label, control);
        grid.append(row);
      }
      section.append(heading, grid);
      container.append(section);
    }
    if (!assessmentFields.length) {
      const empty = document.createElement("p");
      empty.className = "assessment-empty";
      empty.textContent = "評価項目はありません。「評価項目・損傷種類を管理」から追加できます。";
      container.append(empty);
    }
  }

  function collectAssessmentValues() {
    const values = {};
    for (const input of document.querySelectorAll("[data-assessment-field-id]")) {
      const field = assessmentFields.find((entry) => entry.id === Number(input.dataset.assessmentFieldId));
      if (!field) continue;
      if (field.field_type === "checkbox") {
        values[field.id] = input.checked;
      } else if (input.value !== "") {
        values[field.id] = input.value;
      }
    }
    return values;
  }

  function renderInspectionDiagram() {
    const palette = document.querySelector("#damage-type-palette");
    const markers = document.querySelector("#inspection-markers");
    const markList = document.querySelector("#inspection-mark-list");
    const hint = document.querySelector("#inspection-hint");
    palette.replaceChildren();
    markers.replaceChildren();
    markList.replaceChildren();
    for (const type of damageTypes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `damage-type-button${selectedDamageTypeId === type.id ? " active" : ""}`;
      button.textContent = `${type.icon} ${type.name}`;
      button.dataset.damageTypeId = type.id;
      button.addEventListener("pointerdown", startInspectionIssueDrag);
      button.addEventListener("click", () => {
        if (suppressDamageClick) {
          suppressDamageClick = false;
          return;
        }
        selectedDamageTypeId = type.id;
        renderInspectionDiagram();
        hint.textContent = `${type.icon} ${type.name}を車体図の位置でタップして記録します。`;
      });
      palette.append(button);
    }
    if (!damageTypes.length) {
      const empty = document.createElement("span");
      empty.className = "assessment-empty";
      empty.textContent = "問題種類はありません。「評価項目・損傷種類を管理」から追加できます。";
      palette.append(empty);
    }
    inspectionMarks.forEach((mark, index) => {
      const type = damageTypes.find((entry) => entry.id === mark.damage_type_id);
      if (!type) return;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "inspection-marker";
      marker.style.left = `${mark.x * 100}%`;
      marker.style.top = `${mark.y * 100}%`;
      marker.style.backgroundColor = type.color;
      marker.textContent = type.icon;
      marker.title = `${type.name}（クリックして削除）`;
      marker.setAttribute("aria-label", `${type.name}の記録を削除`);
      marker.addEventListener("click", (event) => {
        event.stopPropagation();
        inspectionMarks.splice(index, 1);
        renderInspectionDiagram();
      });
      markers.append(marker);
      const entry = document.createElement("span");
      entry.className = "inspection-mark-entry";
      entry.textContent = `${type.icon} ${type.name} · ${Math.round(mark.x * 100)}%, ${Math.round(mark.y * 100)}%`;
      markList.append(entry);
    });
    hint.textContent = selectedDamageTypeId
      ? `${damageTypes.find((type) => type.id === selectedDamageTypeId)?.name || ""}：車体図をタップして記録`
      : damageTypes.length
        ? "問題の種類をドラッグするか、選択して車体図をタップしてください。"
        : "先に問題種類を追加してください。";
  }

  function addInspectionMark(typeId, clientX, clientY) {
    const view = document.querySelector("#inspection-car-view");
    const rect = view.getBoundingClientRect();
    const type = damageTypes.find((entry) => entry.id === typeId);
    if (!type || clientX < rect.left || clientX > rect.right ||
        clientY < rect.top || clientY > rect.bottom) return false;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const body = [
      [103 / 600, 215 / 340], [145 / 600, 171 / 340], [184 / 600, 157 / 340],
      [236 / 600, 97 / 340], [283 / 600, 76 / 340], [357 / 600, 78 / 340],
      [412 / 600, 140 / 340], [489 / 600, 164 / 340], [516 / 600, 201 / 340],
      [511 / 600, 239 / 340], [468 / 600, 259 / 340], [150 / 600, 261 / 340],
      [109 / 600, 244 / 340],
    ];
    let inside = false;
    for (let current = 0, previous = body.length - 1; current < body.length; previous = current++) {
      const [currentX, currentY] = body[current];
      const [previousX, previousY] = body[previous];
      if ((currentY > y) !== (previousY > y) &&
          x < (previousX - currentX) * (y - currentY) / (previousY - currentY) + currentX) {
        inside = !inside;
      }
    }
    const inWheel = [[182 / 600, 246 / 340, 30 / 600], [436 / 600, 244 / 340, 32 / 600]]
      .some(([centerX, centerY, radius]) => Math.hypot(x - centerX, y - centerY) <= radius);
    if (!inside && !inWheel) {
      document.querySelector("#inspection-hint").textContent = "マークは車両イラスト上に置いてください。";
      return false;
    }
    inspectionMarks.push({
      id: crypto.randomUUID(),
      damage_type_id: type.id,
      x,
      y,
    });
    selectedDamageTypeId = null;
    renderInspectionDiagram();
    return true;
  }

  function startInspectionIssueDrag(event) {
    if ((event.button !== 0 && event.pointerType === "mouse") || inspectionIssueDrag) return;
    event.preventDefault();
    const button = event.currentTarget;
    const type = damageTypes.find((entry) => entry.id === Number(button.dataset.damageTypeId));
    if (!type) return;
    inspectionIssueDrag = {
      type,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      button,
    };
    button.setPointerCapture(event.pointerId);
  }

  function moveInspectionIssueDrag(event) {
    if (!inspectionIssueDrag || event.pointerId !== inspectionIssueDrag.pointerId) return;
    const drag = inspectionIssueDrag;
    if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 7) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    if (!drag.ghost) {
      drag.ghost = document.createElement("div");
      drag.ghost.className = "inspection-drag-ghost";
      drag.ghost.style.backgroundColor = drag.type.color;
      drag.ghost.textContent = `${drag.type.icon} ${drag.type.name}`;
      document.body.append(drag.ghost);
      drag.button.classList.add("dragging");
    }
    drag.ghost.style.left = `${event.clientX}px`;
    drag.ghost.style.top = `${event.clientY}px`;
  }

  function endInspectionIssueDrag(event) {
    if (!inspectionIssueDrag || event.pointerId !== inspectionIssueDrag.pointerId) return;
    const drag = inspectionIssueDrag;
    inspectionIssueDrag = null;
    drag.ghost?.remove();
    drag.button.classList.remove("dragging");
    if (drag.moved) {
      suppressDamageClick = true;
      addInspectionMark(drag.type.id, event.clientX, event.clientY);
      window.setTimeout(() => { suppressDamageClick = false; }, 0);
    }
  }

  function renderAssessmentManager() {
    const fields = document.querySelector("#assessment-field-manager-list");
    const types = document.querySelector("#damage-type-manager-list");
    fields.replaceChildren();
    types.replaceChildren();
    for (const field of assessmentFields) {
      const row = document.createElement("div");
      row.className = "assessment-manager-row";
      const label = document.createElement("span");
      label.textContent = `${field.name} · ${
        { rating: "1〜5 評価", checkbox: "チェック", text: "テキスト", number: "数値" }[field.field_type]
      }${field.suffix ? `（${field.suffix}）` : ""}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", () => removeAssessmentItem(
        `/api/assessment-fields/${field.id}`, remove, `${field.name}を削除しますか？保存済み評価からも削除されます。`,
      ));
      row.append(label, remove);
      fields.append(row);
    }
    for (const type of damageTypes) {
      const row = document.createElement("div");
      row.className = "assessment-manager-row";
      const label = document.createElement("span");
      label.textContent = `${type.icon} ${type.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", () => removeAssessmentItem(
        `/api/damage-types/${type.id}`, remove, `${type.name}を削除しますか？記録済みの車体マークも削除されます。`,
      ));
      row.append(label, remove);
      types.append(row);
    }
  }

  async function removeAssessmentItem(path, button, confirmationMessage) {
    assessmentManagerError.textContent = "";
    if (!window.confirm(confirmationMessage)) return;
    button.disabled = true;
    try {
      await api(path, { method: "DELETE" });
      await loadBoard();
      renderAssessmentManager();
      renderInspectionDiagram();
    } catch (error) {
      assessmentManagerError.textContent = error.message;
      button.disabled = false;
    }
  }

  function renderLocationManager() {
    const list = document.querySelector("#location-list");
    list.replaceChildren();
    for (const lot of lots) {
      const row = document.createElement("div");
      row.className = "location-row";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 40;
      input.required = true;
      input.value = lot.name;
      input.setAttribute("aria-label", `${lot.name}の位置名`);
      const navigationInput = document.createElement("input");
      navigationInput.type = "url";
      navigationInput.maxLength = 2000;
      navigationInput.value = lot.navigation_url || "";
      navigationInput.placeholder = "Googleマップのナビリンク（任意）";
      navigationInput.setAttribute("aria-label", `${lot.name}のGoogleマップナビリンク`);
      const save = document.createElement("button");
      save.type = "button";
      save.className = "primary-button";
      save.textContent = "保存";
      save.addEventListener("click", async () => {
        locationError.textContent = "";
        if (!input.reportValidity() || !navigationInput.reportValidity()) return;
        try {
          await api(`/api/parking-lots/${lot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: input.value, navigation_url: navigationInput.value }),
          });
          await loadBoard();
          renderLocationManager();
        } catch (error) {
          locationError.textContent = error.message;
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.title = "車両が配置されている位置は削除できません";
      remove.addEventListener("click", async () => {
        locationError.textContent = "";
        if (!window.confirm(`位置「${lot.name}」を削除しますか？`)) return;
        try {
          await api(`/api/parking-lots/${lot.id}`, { method: "DELETE" });
          lots = lots.filter((entry) => entry.id !== lot.id);
          render();
          renderLocationManager();
        } catch (error) {
          locationError.textContent = error.message;
        }
      });
      row.append(input, navigationInput, save, remove);
      list.append(row);
    }
  }

  function openLocationManager() {
    if (!canManage) return;
    locationError.textContent = "";
    renderLocationManager();
    locationDialog.showModal();
  }

  async function loadFranchises() {
    const result = await api("/api/franchises");
    const list = document.querySelector("#franchise-list");
    list.replaceChildren();
    if (!result.franchises.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "加盟店はまだ登録されていません。";
      list.append(empty);
      return;
    }
    for (const franchise of result.franchises) {
      const row = document.createElement("div");
      row.className = "franchise-row";
      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = franchise.name;
      const account = document.createElement("span");
      account.textContent = `管理者：${franchise.admin_usernames || "未登録"}`;
      const state = document.createElement("span");
      state.className = franchise.is_active ? "franchise-active" : "franchise-suspended";
      state.textContent = franchise.is_active ? "利用中" : "利用停止中";
      details.append(name, account, state);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = franchise.is_active ? "danger-button" : "primary-button";
      toggle.textContent = franchise.is_active ? "利用停止" : "利用再開";
      toggle.addEventListener("click", async () => {
        franchiseError.textContent = "";
        toggle.disabled = true;
        try {
          await api(`/api/franchises/${franchise.id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ is_active: !franchise.is_active }),
          });
          await loadFranchises();
        } catch (error) {
          franchiseError.textContent = error.message;
        } finally {
          toggle.disabled = false;
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button franchise-delete-button";
      remove.textContent = "加盟店を削除";
      remove.addEventListener("click", () => {
        row.querySelector(".franchise-delete-confirm")?.remove();
        const confirmation = document.createElement("div");
        confirmation.className = "franchise-delete-confirm";
        const warning = document.createElement("span");
        warning.textContent = `全アカウント・車両・位置を削除します。続行するには「${franchise.name}」を入力してください。`;
        const input = document.createElement("input");
        input.type = "text";
        input.autocomplete = "off";
        input.placeholder = franchise.name;
        input.setAttribute("aria-label", "削除する加盟店名");
        const actions = document.createElement("div");
        actions.className = "franchise-delete-actions";
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "danger-button";
        confirm.textContent = "完全に削除";
        confirm.addEventListener("click", async () => {
          franchiseError.textContent = "";
          if (input.value.trim() !== franchise.name) {
            franchiseError.textContent = "加盟店名が一致しません。";
            return;
          }
          confirm.disabled = true;
          try {
            await api(`/api/franchises/${franchise.id}`, {
              method: "DELETE",
              body: JSON.stringify({ confirmation_name: input.value }),
            });
            await loadFranchises();
          } catch (error) {
            franchiseError.textContent = error.message;
            confirm.disabled = false;
          }
        });
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "quiet-button";
        cancel.textContent = "キャンセル";
        cancel.addEventListener("click", () => confirmation.remove());
        actions.append(confirm, cancel);
        confirmation.append(warning, input, actions);
        row.append(confirmation);
        input.focus();
      });
      const buttons = document.createElement("div");
      buttons.className = "franchise-row-actions";
      buttons.append(toggle, remove);
      row.append(details, buttons);
      list.append(row);
    }
  }

  function openFranchiseManager() {
    if (!canManageFranchises) return;
    franchiseError.textContent = "";
    loadFranchises().catch((error) => {
      franchiseError.textContent = error.message;
    });
    franchiseDialog.showModal();
  }

  function openVehicle(vehicle = null) {
    if (!vehicle && !canManage) return;
    vehicleForm.reset();
    formError.textContent = "";
    document.querySelector("#dialog-title").textContent = vehicle ? "車両情報を編集" : "車両を追加";
    document.querySelector("#manage-assessment-button").hidden = !canManage;
    document.querySelector("#delete-vehicle").hidden = !vehicle || !canManage;
    const defaultLot = lots.find((lot) => lot.name === "予備") || lots[0];
    document.querySelector(".default-location-note").textContent =
      `追加した車両は「${defaultLot?.name || "最初の位置"}」に登録されます。`;
    vehicleForm.elements.id.value = vehicle?.id || "";
    vehicleForm.elements.plate.value = vehicle?.plate || "";
    vehicleForm.elements.vehicle_type.value = vehicle?.vehicle_type || vehicleTypes[0] || "";
    for (const input of vehicleForm.querySelectorAll('input[name="options"]')) {
      input.checked = Boolean(vehicle?.options?.includes(input.value));
    }
    renderVehicleStatusOptions(vehicle);
    inspectionMarks = vehicle?.inspection_marks?.map((mark) => ({ ...mark })) || [];
    selectedDamageTypeId = null;
    renderAssessmentFields(vehicle?.assessment_values || {});
    renderInspectionDiagram();
    dialog.showModal();
  }

  function openAssessmentManager() {
    if (!canManage) return;
    assessmentManagerError.textContent = "";
    renderAssessmentManager();
    assessmentManagerDialog.showModal();
  }

  function openStatusManager() {
    if (!canManage) return;
    statusError.textContent = "";
    renderStatusManager();
    statusDialog.showModal();
  }

  function connectSocket() {
    if (socket) socket.close();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.addEventListener("open", () => setConnection(true));
    socket.addEventListener("message", () => loadBoard().catch(showError));
    socket.addEventListener("close", (event) => {
      setConnection(false);
      if (event.code === 4003 || event.code === 4004) {
        loginError.textContent = event.code === 4003
          ? "この加盟店アカウントは一時停止中です。総本店へお問い合わせください。"
          : "この加盟店アカウントは削除されました。総本店へお問い合わせください。";
        showLogin();
        return;
      }
      if (!appScreen.hidden) window.setTimeout(connectSocket, 2000);
    });
    socket.addEventListener("error", () => socket.close());
  }

  function setConnection(connected) {
    const state = document.querySelector("#connection-state");
    state.classList.toggle("offline", !connected);
    state.lastChild.textContent = connected ? "接続中" : "再接続中";
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.textContent = "";
    const form = new FormData(loginForm);
    try {
      const result = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      loginForm.reset();
      showBoard(
        result.username,
        result.can_manage,
        result.can_manage_franchises,
        result.tenant_name,
      );
    } catch (error) {
      loginError.textContent = error.message;
    }
  });

  document.querySelector("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
      showLogin();
    } catch (error) {
      showError(error);
    }
  });
  document.querySelector("#add-vehicle-button").addEventListener("click", () => openVehicle());
  document.querySelector("#manage-locations-button").addEventListener("click", openLocationManager);
  document.querySelector("#manage-franchises-button").addEventListener("click", openFranchiseManager);
  document.querySelector("#manage-statuses-button").addEventListener("click", openStatusManager);
  document.querySelector("#manage-assessment-button").addEventListener("click", openAssessmentManager);
  document.querySelector("#close-location-dialog").addEventListener("click", () => locationDialog.close());
  document.querySelector("#close-franchise-dialog").addEventListener("click", () => franchiseDialog.close());
  document.querySelector("#close-status-dialog").addEventListener("click", () => statusDialog.close());
  document.querySelector("#close-assessment-manager").addEventListener("click", () => assessmentManagerDialog.close());
  document.querySelector("#add-status-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    statusError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    try {
      await api("/api/statuses", {
        method: "POST",
        body: JSON.stringify({ name: data.get("name"), icon: data.get("icon") }),
      });
      form.reset();
      await loadBoard();
      renderStatusManager();
    } catch (error) {
      statusError.textContent = error.message;
    }
  });
  document.querySelector("#add-assessment-field-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    assessmentManagerError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    try {
      await api("/api/assessment-fields", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          field_type: data.get("field_type"),
          suffix: data.get("suffix"),
        }),
      });
      form.reset();
      const currentValues = collectAssessmentValues();
      await loadBoard();
      renderAssessmentFields(currentValues);
      renderAssessmentManager();
      renderInspectionDiagram();
    } catch (error) {
      assessmentManagerError.textContent = error.message;
    }
  });
  document.querySelector("#add-damage-type-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    assessmentManagerError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    try {
      await api("/api/damage-types", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          icon: data.get("icon"),
          color: data.get("color"),
        }),
      });
      form.reset();
      const currentValues = collectAssessmentValues();
      await loadBoard();
      renderAssessmentFields(currentValues);
      renderAssessmentManager();
      renderInspectionDiagram();
    } catch (error) {
      assessmentManagerError.textContent = error.message;
    }
  });
  document.querySelector("#add-franchise-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    franchiseError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    try {
      await api("/api/franchises", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          username: data.get("username"),
          password: data.get("password"),
        }),
      });
      form.reset();
      await loadFranchises();
    } catch (error) {
      franchiseError.textContent = error.message;
    }
  });
  document.querySelector("#add-location-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    locationError.textContent = "";
    const form = event.currentTarget;
    const nameInput = form.elements.name;
    const navigationInput = form.elements.navigation_url;
    if (!nameInput.reportValidity() || !navigationInput.reportValidity()) return;
    try {
      await api("/api/parking-lots", {
        method: "POST",
        body: JSON.stringify({ name: nameInput.value, navigation_url: navigationInput.value }),
      });
      form.reset();
      await loadBoard();
      renderLocationManager();
    } catch (error) {
      locationError.textContent = error.message;
    }
  });
  document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
  document.querySelector("#cancel-dialog").addEventListener("click", () => dialog.close());
  document.querySelector("#inspection-car-view").addEventListener("click", (event) => {
    if (suppressDamageClick) return;
    if (!selectedDamageTypeId) {
      document.querySelector("#inspection-hint").textContent = "先に問題の種類を選ぶか、車体図へドラッグしてください。";
      return;
    }
    if (addInspectionMark(selectedDamageTypeId, event.clientX, event.clientY)) {
      document.querySelector("#inspection-hint").textContent = "損傷位置を記録しました。マーカーをクリックすると削除できます。";
    }
  });
  document.querySelector("#delete-vehicle").addEventListener("click", async () => {
    if (!canManage) return;
    const id = vehicleForm.elements.id.value;
    if (!id || !window.confirm("この車両を削除しますか？")) return;
    try {
      await api(`/api/vehicles/${id}`, { method: "DELETE" });
      dialog.close();
      await loadBoard();
    } catch (error) {
      formError.textContent = error.message;
    }
  });
  vehicleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    const form = new FormData(vehicleForm);
    const id = form.get("id");
    const payload = {
      plate: form.get("plate"),
      vehicle_type: form.get("vehicle_type"),
      options: form.getAll("options"),
    };
    payload.status_ids = form.getAll("status_ids").map(Number);
    payload.assessment_values = collectAssessmentValues();
    payload.inspection_marks = inspectionMarks;
    try {
      await api(id ? `/api/vehicles/${id}` : "/api/vehicles", {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      activeVehicleType = "all";
      dialog.close();
      await loadBoard();
    } catch (error) {
      formError.textContent = error.message;
    }
  });
  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      activeStatus = button.dataset.filter;
      document.querySelectorAll(".filter-button").forEach((item) => item.classList.toggle("active", item === button));
      renderStatusList(vehicles);
    });
  });
  api("/api/me").then((result) => {
    if (result.authenticated) {
      showBoard(result.username, result.can_manage, result.can_manage_franchises, result.tenant_name);
    } else {
      showLogin();
      if (result.suspended) {
        loginError.textContent = "この加盟店アカウントは一時停止中です。総本店へお問い合わせください。";
      }
    }
  }).catch(showLogin);
})();
