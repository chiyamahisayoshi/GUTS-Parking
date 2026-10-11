(() => {
  const loginScreen = document.querySelector("#login-screen");
  const appScreen = document.querySelector("#app-screen");
  const loginForm = document.querySelector("#login-form");
  const loginError = document.querySelector("#login-error");
  const boardSections = document.querySelector("#board-sections");
  const dialog = document.querySelector("#vehicle-dialog");
  const vehicleForm = document.querySelector("#vehicle-form");
  const formError = document.querySelector("#form-error");
  const statuses = ["unwashed", "no_fuel", "needs_repair"];
  const statusLabels = { unwashed: "洗車待ち", no_fuel: "給油待ち", needs_repair: "要修理" };
  const statusIcons = { unwashed: "🫧", no_fuel: "⛽", needs_repair: "🔧" };
  const optionNames = ["ETC", "車載器", "禁煙", "喫煙", "ナビ", "スタッドレス"];
  let lots = [];
  let vehicles = [];
  let vehicleTypes = [];
  let activeVehicleType = "all";
  let activeStatus = "all";
  let socket;
  let dragged = null;
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
    if (dragged) return;
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
    boardSections.replaceChildren();
    for (const sectionName of ["本店貸出中", "駅前店貸出中", "予備"]) {
      const section = document.createElement("section");
      section.className = "board-section";
      section.dataset.boardSection = sectionName;
      const heading = document.createElement("div");
      heading.className = "board-section-heading";
      const title = document.createElement("h2");
      title.textContent = sectionName;
      const count = document.createElement("span");
      const sectionVehicles = vehicles.filter((vehicle) => vehicle.board_section === sectionName);
      count.textContent = `${sectionVehicles.length} 台`;
      heading.append(title, count);
      const parkingGrid = document.createElement("div");
      parkingGrid.className = "parking-grid";
      const unparked = sectionVehicles.filter((vehicle) => vehicle.parking_lot_id === null);
      parkingGrid.append(makeParkingCard({
        id: "none",
        name: "未配置",
        area_height: 210,
        area_width: 1,
      }, unparked, sectionName));
      for (const lot of lots) {
        const inLot = sectionVehicles.filter((vehicle) => vehicle.parking_lot_id === lot.id);
        parkingGrid.append(makeParkingCard(lot, inLot, sectionName));
      }
      section.append(heading, parkingGrid);
      boardSections.append(section);
    }
    document.querySelector("#vehicle-count").textContent = vehicles.length;
    document.querySelector("#lot-count").textContent = lots.length;
    document.querySelector("#attention-count").textContent = vehicles.filter((vehicle) =>
      statuses.some((status) => vehicle[status]),
    ).length;
    renderVehicleCatalog(vehicles);
    renderStatusList(vehicles);
  }

  function makeParkingCard(lot, inLot, sectionName) {
    const card = document.createElement("article");
    card.className = `lot-card${lot.id === "none" ? " reserve-card" : ""}`;
    card.dataset.lotId = lot.id;
    const heading = document.createElement("div");
    heading.className = "lot-heading";
    if (lot.id !== "none") {
      heading.draggable = true;
      heading.title = "駐車場カードをドラッグして並べ替え";
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
    }
    const headingTitle = document.createElement("div");
    headingTitle.className = "lot-heading-title";
    const title = document.createElement("h3");
    title.textContent = lot.name;
    const count = document.createElement("span");
    count.className = "lot-count";
    count.textContent = `${inLot.length} 台`;
    headingTitle.append(title, count);
    heading.append(headingTitle);
    if (lot.id !== "none") {
      const controls = document.createElement("div");
      controls.className = "lot-controls";
      const resize = document.createElement("button");
      resize.type = "button";
      resize.className = "lot-control";
      resize.textContent = "尺寸";
      resize.title = "顯示尺寸調整按鈕";
      resize.addEventListener("click", () => {
        card.classList.toggle("size-editing");
        resize.textContent = card.classList.contains("size-editing") ? "完成" : "尺寸";
      });
      const shorter = makeLotControl("−", "減少高度", () => updateLotLayout(lot, {
        area_height: Math.max(160, lot.area_height - 40),
      }));
      const taller = makeLotControl("+", "增加高度", () => updateLotLayout(lot, {
        area_height: Math.min(600, lot.area_height + 40),
      }));
      const width = makeLotControl(lot.area_width === 2 ? "窄" : "寬", "切換寬度", () =>
        updateLotLayout(lot, { area_width: lot.area_width === 2 ? 1 : 2 }));
      const earlier = makeLotControl("←", "向前移一格", () => moveLot(lot.id, -1));
      const later = makeLotControl("→", "向後移一格", () => moveLot(lot.id, 1));
      controls.append(resize, shorter, taller, width, earlier, later);
      heading.append(controls);
    }
    const area = document.createElement("div");
    area.className = "lot-area";
    area.dataset.lotId = lot.id;
    area.dataset.boardSection = sectionName;
    area.style.height = `${Math.max(lot.area_height, Math.ceil(inLot.length / 4) * 52 + 24)}px`;
    if (lot.area_width === 2) card.classList.add("lot-wide");
    if (!inLot.length) area.classList.add("empty");
    for (const vehicle of inLot) area.append(makeToken(vehicle));
    card.append(heading, area);
    return card;
  }

  function makeLotControl(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lot-control size-control";
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
    const dropSection = dropArea?.dataset.boardSection;
    dragged = null;
    current.ghost.remove();
    document.querySelectorAll(".lot-area.drop-target").forEach((area) => area.classList.remove("drop-target"));
    if (!current.moved) return;
    suppressClick = true;
    if (!dropArea || !dropSection) {
      window.setTimeout(() => { suppressClick = false; }, 0);
      return;
    }
    const rect = dropArea.getBoundingClientRect();
    const position = {
      board_section: dropSection,
      position_x: Math.max(0, Math.min(1, (event.clientX - rect.left - rect.width * 0.08) / (rect.width * 0.84))),
      position_y: Math.max(0, Math.min(1, (event.clientY - rect.top - rect.height * 0.1) / (rect.height * 0.8))),
      parking_lot_id: dropArea.dataset.lotId === "none" ? null : Number(dropArea.dataset.lotId),
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
  document.addEventListener("pointerup", (event) => endDrag(event));
  document.addEventListener("pointercancel", (event) => endDrag(event, true));

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
      details.textContent = `${vehicle.board_section} · ${vehicle.vehicle_type} · ${lot?.name || "未配置"}${vehicle.options?.length ? ` · ${vehicle.options.join("・")}` : ""}`;
      item.append(plate, details);
      item.addEventListener("click", () => {
        const section = [...document.querySelectorAll(".board-section")]
          .find((entry) => entry.dataset.boardSection === vehicle.board_section);
        const location = section?.querySelector(`[data-lot-id="${vehicle.parking_lot_id ?? "none"}"]`);
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
      description.textContent = `${vehicle.board_section} · ${lot?.name || "未配置"} · ${active.join(" / ") || vehicle.vehicle_type}`;
      item.append(plate, description);
      item.addEventListener("click", () => {
        const section = [...document.querySelectorAll(".board-section")]
          .find((entry) => entry.dataset.boardSection === vehicle.board_section);
        section?.querySelector(`[data-lot-id="${vehicle.parking_lot_id ?? "none"}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
        document.querySelector(`[data-id="${vehicle.id}"]`)?.focus({ preventScroll: true });
      });
      list.append(item);
    }
  }

  function openVehicle(vehicle = null) {
    vehicleForm.reset();
    formError.textContent = "";
    document.querySelector("#dialog-title").textContent = vehicle ? "車両情報を編集" : "車両を追加";
    document.querySelector("#delete-vehicle").hidden = !vehicle;
    vehicleForm.elements.id.value = vehicle?.id || "";
    vehicleForm.elements.plate.value = vehicle?.plate || "";
    vehicleForm.elements.vehicle_type.value = vehicle?.vehicle_type || vehicleTypes[0] || "";
    vehicleForm.elements.board_section.value = vehicle?.board_section || "予備";
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
      board_section: form.get("board_section"),
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
