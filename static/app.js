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
  const statuses = ["unwashed", "no_fuel", "needs_repair"];
  const statusLabels = { unwashed: "洗車待ち", no_fuel: "給油待ち", needs_repair: "要修理" };
  const statusIcons = { unwashed: "🫧", no_fuel: "⛽", needs_repair: "🔧" };
  let lots = [];
  let vehicles = [];
  let vehicleTypes = [];
  let activeVehicleType = "all";
  let activeStatus = "all";
  let socket;
  let dragged = null;
  let resizing = null;
  let suppressClick = false;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/login") showLogin();
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }

  function showLogin() {
    appScreen.hidden = true;
    loginScreen.hidden = false;
    if (socket) socket.close();
  }

  function showBoard(username) {
    loginScreen.hidden = true;
    appScreen.hidden = false;
    document.querySelector("#current-user").textContent = username;
    connectSocket();
    loadBoard().catch(showError);
  }

  function showError(error) {
    console.error(error);
    formError.textContent = error.message;
  }

  async function loadBoard() {
    if (dragged || resizing) return;
    const data = await api("/api/bootstrap");
    lots = data.parking_lots;
    vehicles = data.vehicles;
    vehicleTypes = data.vehicle_types;
    populateVehicleTypeChoices();
    render();
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
      statuses.some((status) => vehicle[status]),
    ).length;
    renderVehicleCatalog(vehicles);
    renderStatusList(vehicles);
  }

  function makeParkingCard(lot, inLot) {
    const card = document.createElement("article");
    card.className = "lot-card";
    card.dataset.lotId = lot.id;
    const heading = document.createElement("div");
    heading.className = "lot-heading";
    heading.draggable = true;
    heading.title = "エリアカードをドラッグして並べ替え";
    heading.addEventListener("dragstart", (event) => {
      if (event.target.closest("button")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData("text/plain", String(lot.id));
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("reordering");
    });
    heading.addEventListener("dragend", () => card.classList.remove("reordering"));
    card.addEventListener("dragover", (event) => {
      if (event.dataTransfer.types.includes("text/plain")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }
    });
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceId = Number(event.dataTransfer.getData("text/plain"));
      if (sourceId && sourceId !== lot.id) reorderLots(sourceId, lot.id).catch(showError);
    });
    const headingTitle = document.createElement("div");
    headingTitle.className = "lot-heading-title";
    const title = document.createElement("h3");
    title.textContent = lot.name;
    const count = document.createElement("span");
    count.className = "lot-count";
    count.textContent = `${inLot.length} 台`;
    headingTitle.append(title, count);
    heading.append(headingTitle);
    const controls = document.createElement("div");
    controls.className = "lot-controls";
    const resize = document.createElement("button");
    resize.type = "button";
    resize.className = "lot-control";
    resize.textContent = "尺寸";
    resize.title = "クリック後、右下のハンドルをドラッグしてサイズを調整";
    resize.addEventListener("click", () => {
      card.classList.toggle("size-editing");
      resize.textContent = card.classList.contains("size-editing") ? "完成" : "尺寸";
    });
    const earlier = makeLotControl("←", "向前移一格", () => moveLot(lot.id, -1));
    const later = makeLotControl("→", "向後移一格", () => moveLot(lot.id, 1));
    controls.append(resize, earlier, later);
    heading.append(controls);
    const area = document.createElement("div");
    area.className = "lot-area";
    area.dataset.lotId = lot.id;
    area.style.height = `${Math.max(lot.area_height, Math.ceil(inLot.length / 4) * 52 + 24)}px`;
    card.style.setProperty("--lot-width", `${lot.area_width}%`);
    if (!inLot.length) area.classList.add("empty");
    for (const vehicle of inLot) area.append(makeToken(vehicle));
    const resizeHandle = document.createElement("button");
    resizeHandle.type = "button";
    resizeHandle.className = "lot-resize-handle";
    resizeHandle.textContent = "◢";
    resizeHandle.setAttribute("aria-label", `${lot.name}のサイズをドラッグして調整`);
    resizeHandle.title = "ドラッグして幅と高さを調整";
    resizeHandle.addEventListener("pointerdown", (event) => startResize(event, lot, card, area));
    area.append(resizeHandle);
    card.append(heading, area);
    return card;
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
      ...statuses.filter((status) => vehicle[status]).map((status) => statusIcons[status]),
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
      moved: false,
    };
  }

  function moveDrag(event) {
    if (!dragged || event.pointerId !== dragged.pointerId) return;
    if (Math.abs(event.clientX - dragged.startX) + Math.abs(event.clientY - dragged.startY) > 5) {
      dragged.moved = true;
    }
    if (!dragged.moved) return;
    dragged.ghost.style.left = `${event.clientX}px`;
    dragged.ghost.style.top = `${event.clientY}px`;
    document.querySelectorAll(".lot-area.drop-target").forEach((area) => area.classList.remove("drop-target"));
    document.elementFromPoint(event.clientX, event.clientY)
      ?.closest(".lot-area")?.classList.add("drop-target");
  }

  async function endDrag(event, cancelled = false) {
    if (!dragged || event.pointerId !== dragged.pointerId) return;
    const current = dragged;
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
  document.addEventListener("pointerup", (event) => endDrag(event));
  document.addEventListener("pointerup", (event) => endResize(event));
  document.addEventListener("pointercancel", (event) => endDrag(event, true));
  document.addEventListener("pointercancel", (event) => endResize(event, true));

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

  function renderStatusList(boardVehicles) {
    const list = document.querySelector("#status-list");
    list.replaceChildren();
    const filtered = boardVehicles.filter((vehicle) => activeStatus === "all" || vehicle[activeStatus]);
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
      const active = statuses.filter((status) => vehicle[status]).map((status) => statusLabels[status]);
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
      const save = document.createElement("button");
      save.type = "button";
      save.className = "quiet-button";
      save.textContent = "名前を保存";
      save.addEventListener("click", async () => {
        locationError.textContent = "";
        if (!input.reportValidity()) return;
        try {
          await api(`/api/parking-lots/${lot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: input.value }),
          });
          await loadBoard();
          renderLocationManager();
        } catch (error) {
          locationError.textContent = error.message;
        }
      });
      row.append(input, save);
      list.append(row);
    }
  }

  function openLocationManager() {
    locationError.textContent = "";
    renderLocationManager();
    locationDialog.showModal();
  }

  function openVehicle(vehicle = null) {
    vehicleForm.reset();
    formError.textContent = "";
    document.querySelector("#dialog-title").textContent = vehicle ? "車両情報を編集" : "車両を追加";
    document.querySelector("#delete-vehicle").hidden = !vehicle;
    vehicleForm.elements.id.value = vehicle?.id || "";
    vehicleForm.elements.plate.value = vehicle?.plate || "";
    vehicleForm.elements.vehicle_type.value = vehicle?.vehicle_type || vehicleTypes[0] || "";
    for (const input of vehicleForm.querySelectorAll('input[name="options"]')) {
      input.checked = Boolean(vehicle?.options?.includes(input.value));
    }
    for (const status of statuses) vehicleForm.elements[status].checked = Boolean(vehicle?.[status]);
    dialog.showModal();
  }

  function connectSocket() {
    if (socket) socket.close();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.addEventListener("open", () => setConnection(true));
    socket.addEventListener("message", () => loadBoard().catch(showError));
    socket.addEventListener("close", () => {
      setConnection(false);
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
      showBoard(result.username);
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
  document.querySelector("#close-location-dialog").addEventListener("click", () => locationDialog.close());
  document.querySelector("#add-location-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    locationError.textContent = "";
    const form = event.currentTarget;
    const nameInput = form.elements.name;
    try {
      await api("/api/parking-lots", {
        method: "POST",
        body: JSON.stringify({ name: nameInput.value }),
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
  document.querySelector("#delete-vehicle").addEventListener("click", async () => {
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
    for (const status of statuses) payload[status] = form.has(status);
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
    if (result.authenticated) showBoard(result.username);
    else showLogin();
  }).catch(showLogin);
})();
