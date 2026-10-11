(() => {
  const loginScreen = document.querySelector("#login-screen");
  const appScreen = document.querySelector("#app-screen");
  const loginForm = document.querySelector("#login-form");
  const loginError = document.querySelector("#login-error");
  const parkingGrid = document.querySelector("#parking-grid");
  const dialog = document.querySelector("#vehicle-dialog");
  const vehicleForm = document.querySelector("#vehicle-form");
  const formError = document.querySelector("#form-error");
  const statuses = ["unwashed", "no_fuel", "needs_repair"];
  const statusLabels = { unwashed: "洗車待ち", no_fuel: "給油待ち", needs_repair: "要修理" };
  const statusIcons = { unwashed: "🫧", no_fuel: "⛽", needs_repair: "🔧" };
  let lots = [];
  let vehicles = [];
  let activeFilter = "all";
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
    const data = await api("/api/bootstrap");
    lots = data.parking_lots;
    vehicles = data.vehicles;
    render();
  }

  function typeClass(type) {
    return ["hybrid", "ev", "van"].includes(type) ? `type-${type}` : "type-standard";
  }

  function render() {
    parkingGrid.replaceChildren();
    for (const lot of lots) {
      const card = document.createElement("article");
      card.className = "lot-card";
      const inLot = vehicles.filter((vehicle) => vehicle.parking_lot_id === lot.id);
      card.innerHTML = '<div class="lot-heading"><h3></h3><span class="lot-count"></span></div><div class="lot-area"></div>';
      card.querySelector("h3").textContent = lot.name;
      card.querySelector(".lot-count").textContent = `${inLot.length} 台`;
      const area = card.querySelector(".lot-area");
      area.dataset.lotId = lot.id;
      area.style.height = `${Math.max(210, Math.ceil(inLot.length / 4) * 52 + 24)}px`;
      if (inLot.length === 0) area.classList.add("empty");
      for (const vehicle of inLot) area.append(makeToken(vehicle));
      parkingGrid.append(card);
    }
    document.querySelector("#vehicle-count").textContent = vehicles.length;
    document.querySelector("#lot-count").textContent = lots.length;
    document.querySelector("#attention-count").textContent = vehicles.filter((vehicle) =>
      statuses.some((status) => vehicle[status]),
    ).length;
    populateLotSelect();
    renderStatusList();
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
    const flags = statuses.filter((status) => vehicle[status]);
    if (flags.length) {
      const badges = document.createElement("span");
      badges.className = "token-badges";
      badges.textContent = flags.map((status) => statusIcons[status]).join("");
      token.append(badges);
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
    if (event.button !== 0) return;
    const token = event.currentTarget;
    dragged = {
      id: Number(token.dataset.id),
      token,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    token.setPointerCapture(event.pointerId);
    token.addEventListener("pointermove", moveDrag);
    token.addEventListener("pointerup", endDrag, { once: true });
    token.addEventListener("pointercancel", endDrag, { once: true });
  }

  function moveDrag(event) {
    if (!dragged) return;
    if (Math.abs(event.clientX - dragged.startX) + Math.abs(event.clientY - dragged.startY) > 5) dragged.moved = true;
    if (!dragged.moved) return;
    dragged.token.classList.add("dragging");
    if (dragged.token.parentElement !== document.body) document.body.append(dragged.token);
    dragged.token.style.pointerEvents = "none";
    dragged.token.style.left = `${event.clientX}px`;
    dragged.token.style.top = `${event.clientY}px`;
    dragged.token.style.position = "fixed";
  }

  async function endDrag(event) {
    const current = dragged;
    if (!current) return;
    dragged = null;
    current.token.removeEventListener("pointermove", moveDrag);
    current.token.classList.remove("dragging");
    if (!current.moved) return;
    suppressClick = true;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".lot-area");
    const vehicle = vehicles.find((item) => item.id === current.id);
    const lot = target && lots.find((item) => item.id === Number(target.dataset.lotId));
    if (!lot) {
      current.token.remove();
      await loadBoard();
      suppressClick = false;
      return;
    }
    const area = target;
    const rect = area.getBoundingClientRect();
    const positionX = Math.max(0, Math.min(1, (event.clientX - rect.left - rect.width * 0.08) / (rect.width * 0.84)));
    const positionY = Math.max(0, Math.min(1, (event.clientY - rect.top - rect.height * 0.1) / (rect.height * 0.8)));
    try {
      await api(`/api/vehicles/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parking_lot_id: lot.id, position_x: positionX, position_y: positionY }),
      });
      current.token.remove();
      await loadBoard();
    } catch (error) {
      current.token.remove();
      showError(error);
      await loadBoard();
    }
    window.setTimeout(() => { suppressClick = false; }, 0);
  }

  function populateLotSelect() {
    const select = vehicleForm.elements.parking_lot_id;
    const value = select.value;
    select.replaceChildren(...lots.map((lot) => {
      const option = document.createElement("option");
      option.value = lot.id;
      option.textContent = lot.name;
      return option;
    }));
    if (lots.some((lot) => String(lot.id) === value)) select.value = value;
  }

  function renderStatusList() {
    const list = document.querySelector("#status-list");
    list.replaceChildren();
    const filtered = vehicles.filter((vehicle) => activeFilter === "all" || vehicle[activeFilter]);
    document.querySelector("#status-total").textContent = `${filtered.length} 台`;
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = activeFilter === "all" ? "登録車両はありません。「車両を追加」から登録してください。" : "該当する車両はありません。";
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
      description.textContent = `${lot ? lot.name : "未配置"} · ${active.join(" / ") || vehicle.vehicle_type}`;
      item.append(plate, description);
      item.addEventListener("click", () => {
        if (!lot) return;
        document.querySelector(`[data-lot-id="${lot.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        document.querySelector(`[data-id="${vehicle.id}"]`)?.focus({ preventScroll: true });
      });
      list.append(item);
    }
  }

  function openVehicle(vehicle = null) {
    vehicleForm.reset();
    formError.textContent = "";
    populateLotSelect();
    document.querySelector("#dialog-title").textContent = vehicle ? "車両情報を編集" : "車両を追加";
    document.querySelector("#delete-vehicle").hidden = !vehicle;
    vehicleForm.elements.id.value = vehicle?.id || "";
    vehicleForm.elements.plate.value = vehicle?.plate || "";
    vehicleForm.elements.vehicle_type.value = vehicle?.vehicle_type || "standard";
    vehicleForm.elements.parking_lot_id.value = vehicle?.parking_lot_id ?? (lots[0]?.id || "");
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
      parking_lot_id: Number(form.get("parking_lot_id")),
    };
    for (const status of statuses) payload[status] = form.has(status);
    try {
      await api(id ? `/api/vehicles/${id}` : "/api/vehicles", {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      dialog.close();
      await loadBoard();
    } catch (error) {
      formError.textContent = error.message;
    }
  });
  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll(".filter-button").forEach((item) => item.classList.toggle("active", item === button));
      renderStatusList();
    });
  });
  api("/api/me").then((result) => {
    if (result.authenticated) showBoard(result.username);
    else showLogin();
  }).catch(showLogin);
})();
