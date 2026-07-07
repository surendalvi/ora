// Frontend Application Logic for ORA Cockpit

let trendingChart = null;
let selectedInterval = 'daily';
let activeSubmissions = [];
const maxSelectedTags = 5;

document.addEventListener("DOMContentLoaded", () => {
    // 1. Initialize clock
    updateClock();
    setInterval(updateClock, 1000);

    // 2. SPA Navigation tabs
    initNavigation();

    // 3. Ingestion & Calendar setup
    initIngestion();

    // 4. Validation Cockpit
    loadPendingValidations();

    // 5. Trending Cockpit
    initTrending();

    // 6. Prescriptions Feed
    loadPrescriptions();

    // 7. Manual Entry
    initManualEntry();
    
    // Calendar Month/Year Selectors
    const mSelect = document.getElementById("calendar-month-select");
    const ySelect = document.getElementById("calendar-year-select");
    if (mSelect) mSelect.onchange = () => fetchSummary();
    if (ySelect) ySelect.onchange = () => fetchSummary();

    // Add Field Modal bindings
    const addParamBtn = document.getElementById("add-parameter-btn");
    const closeParamBtn = document.getElementById("close-add-field-btn");
    const paramModal = document.getElementById("add-field-modal");
    const addParamForm = document.getElementById("add-field-form");

    if (addParamBtn && paramModal) {
        addParamBtn.onclick = (e) => {
            e.preventDefault();
            paramModal.style.display = "flex";
        };
    }
    if (closeParamBtn && paramModal) {
        closeParamBtn.onclick = (e) => {
            e.preventDefault();
            paramModal.style.display = "none";
        };
    }
    if (addParamForm && paramModal) {
        addParamForm.onsubmit = async (e) => {
            e.preventDefault();
            
            const subId = document.getElementById("validation-sub-id").value;
            const payload = {
                parameter: document.getElementById("new-param-name").value,
                tag_name: document.getElementById("new-tag-name").value,
                value: parseFloat(document.getElementById("new-param-val").value),
                unit: document.getElementById("new-param-unit").value,
                asset_id: document.getElementById("new-asset-id").value,
                limit_type: document.getElementById("new-limit-type").value,
                limit_value: document.getElementById("new-limit-val").value || null,
                submission_id: subId ? parseInt(subId) : null
            };

            try {
                const res = await fetch("/api/add_tag_definition", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (data.success) {
                    alert("Parameter added successfully!");
                    paramModal.style.display = "none";
                    addParamForm.reset();
                    loadPendingValidations();
                } else {
                    alert("Error: " + data.error);
                }
            } catch (err) {
                console.error(err);
                alert("Failed to add parameter.");
            }
        };
    }
    
    // Initial fetch summary
    initPrescriptionsFilter();
    fetchSummary();
});

// Clock updater
function updateClock() {
    const clock = document.getElementById("clock-display");
    if (clock) {
        const now = new Date();
        clock.innerText = now.toLocaleString();
    }
}

// Navigation Tab Switching
function initNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    const panels = document.querySelectorAll(".tab-panel");
    const title = document.getElementById("current-tab-title");
    const subtitle = document.getElementById("current-tab-subtitle");

    const tabMeta = {
        "overview": {
            title: "Ingestion Overview & Reporting",
            subtitle: "Structured data entry and scan upload facility"
        },
        "validation": {
            title: "Human-in-the-Loop Validation Cockpit",
            subtitle: "Verify AI-OCR character parsing accuracy"
        },
        "trending": {
            title: "Analytics Trends Cockpit",
            subtitle: "Database-driven multi-variable trending and Y-axis scaling"
        },
        "prescriptions": {
            title: "Diagnostics & Prescriptions Feed",
            subtitle: "Data-driven predictive insights and operational prescriptions"
        },
        "analytics": {
            title: "Audit & Analytics Dashboard",
            subtitle: "Tube Metal Temperature profile and prescription action categorization"
        },
        "manual": {
            title: "Manual Rounds Data Entry",
            subtitle: "Structured parameters entry for shift records"
        }
    };

    navItems.forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            const tabName = item.getAttribute("data-tab");

            // Toggle nav active class
            navItems.forEach(nav => nav.classList.remove("active"));
            item.classList.add("active");

            // Toggle panels
            panels.forEach(panel => panel.classList.remove("active"));
            document.getElementById(`tab-${tabName}`).classList.add("active");

            // Update titles
            if (tabMeta[tabName]) {
                title.innerText = tabMeta[tabName].title;
                subtitle.innerText = tabMeta[tabName].subtitle;
            }

            // Tab-specific triggers
            if (tabName === 'trending') {
                setTimeout(loadChartData, 100);
            } else if (tabName === 'validation') {
                loadPendingValidations();
            } else if (tabName === 'prescriptions') {
                loadPrescriptions();
            } else if (tabName === 'analytics') {
                loadAnalyticsTab();
            }
        });
    });

    // Sidebar collapse/minimize toggle
    const toggleBtn = document.getElementById("sidebar-toggle");
    const sidebar = document.getElementById("sidebar-panel");
    if (toggleBtn && sidebar) {
        const isCollapsed = localStorage.getItem("sidebar-collapsed") === "true";
        if (isCollapsed) {
            sidebar.classList.add("collapsed");
            toggleBtn.title = "Maximize Sidebar";
        }
        
        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const nowCollapsed = sidebar.classList.toggle("collapsed");
            localStorage.setItem("sidebar-collapsed", nowCollapsed);
            toggleBtn.title = nowCollapsed ? "Maximize Sidebar" : "Minimize Sidebar";
        });
    }

    // Theme mode toggle (Light/Dark)
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
        const savedTheme = localStorage.getItem("theme");
        if (savedTheme === "dark") {
            document.body.classList.add("dark-mode");
            themeToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
        }
        
        themeToggle.addEventListener("click", () => {
            const isDark = document.body.classList.toggle("dark-mode");
            localStorage.setItem("theme", isDark ? "dark" : "light");
            themeToggle.innerHTML = isDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
            // Re-draw chart so gridlines and text colors align with current theme if active
            const trendingPanel = document.getElementById("tab-trending");
            if (trendingPanel && trendingPanel.classList.contains("active")) {
                loadChartData();
            }
        });
    }
}

// Fetch dashboard global KPIs
async function fetchSummary() {
    try {
        const monthSelect = document.getElementById("calendar-month-select");
        const yearSelect = document.getElementById("calendar-year-select");
        const mVal = monthSelect ? monthSelect.value : "12";
        const yVal = yearSelect ? yearSelect.value : "2023";

        const res = await fetch(`/api/dashboard_summary?year=${yVal}&month=${mVal}`);
        const data = await res.json();

        // Update Overview widgets
        document.getElementById("compliance-val").innerText = `${data.compliance_rate}%`;
        document.getElementById("ingestion-val").innerText = `${data.ingestion_rate}%`;
        document.getElementById("confidence-val-kpi").innerText = `${data.average_confidence}%`;
        document.getElementById("active-alerts-val").innerText = data.active_alerts;
        document.getElementById("schedule-compliance-text").innerText = `Compliance: ${data.compliance_rate}%`;

        // Update compliance card subtext dynamically
        const complianceSub = document.getElementById("compliance-subtext");
        if (complianceSub) {
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            const mIdx = parseInt(mVal) - 1;
            complianceSub.innerText = `${monthNames[mIdx]} ${yVal} packages`;
        }

        // Update nav badges
        const alertBadge = document.getElementById("alerts-badge");
        if (data.active_alerts > 0) {
            alertBadge.innerText = data.active_alerts;
            alertBadge.style.display = "inline-block";
            document.getElementById("critical-alert-count").innerText = data.active_alerts;
        } else {
            alertBadge.style.display = "none";
            document.getElementById("critical-alert-count").innerText = 0;
        }

        // Draw calendar
        renderCalendar();
        
        // Load yield/energy optimization status
        fetchOptimizationStatus();
    } catch (e) {
        console.error("Error fetching summary stats:", e);
    }
}

// Render Dynamic Calendar Grid
async function renderCalendar() {
    const grid = document.getElementById("calendar-grid");
    if (!grid) return;
    grid.innerHTML = "";

    const monthSelect = document.getElementById("calendar-month-select");
    const yearSelect = document.getElementById("calendar-year-select");
    const mVal = monthSelect ? monthSelect.value : "12";
    const yVal = yearSelect ? yearSelect.value : "2023";

    try {
        const res = await fetch(`/api/calendar_status?year=${yVal}&month=${mVal}`);
        const data = await res.json();
        
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        
        // Calculate compliance score: only committed days count as compliant
        const total = data.days.length;
        const committed = data.days.filter(d => d.status === 'committed').length;
        const compliance = Math.round((committed / total) * 100);
        
        const complianceEl = document.getElementById("schedule-compliance-text");
        if (complianceEl) {
            complianceEl.innerText = `Compliance: ${compliance}%`;
        }

        data.days.forEach(dayInfo => {
            const day = dayInfo.day;
            const dayDiv = document.createElement("div");
            dayDiv.classList.add("calendar-day");

            const dayNum = document.createElement("span");
            dayNum.classList.add("day-num");
            dayNum.innerText = day;
            dayDiv.appendChild(dayNum);

            const icon = document.createElement("i");

            if (dayInfo.status === 'missing') {
                dayDiv.classList.add("missing");
                icon.classList.add("fa-solid", "fa-triangle-exclamation", "day-status-icon");
                dayDiv.title = "Log missing. Click to upload scan.";
                dayDiv.addEventListener("click", () => triggerMockUpload(day, `${monthNames[data.month-1]} ${data.year} Package`));
            } else if (dayInfo.status === 'pending') {
                dayDiv.classList.add("missing");
                dayDiv.style.borderColor = "var(--color-warning)";
                dayDiv.style.background = "rgba(245, 158, 11, 0.05)";
                icon.classList.add("fa-solid", "fa-eye-dropper", "day-status-icon");
                icon.style.color = "var(--color-warning)";
                dayDiv.title = "Pending manual validation. Click to check.";
                dayDiv.addEventListener("click", () => {
                    document.querySelector('[data-tab="validation"]').click();
                });
            } else {
                dayDiv.classList.add("committed");
                icon.classList.add("fa-solid", "fa-circle-check", "day-status-icon");
                const dateStr = `${data.year}-${data.month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
                dayDiv.title = "Committed to Historian. Click to explore logs & prescriptions.";
                dayDiv.addEventListener("click", () => openDayModal(dateStr));
            }

            dayDiv.appendChild(icon);
            grid.appendChild(dayDiv);
        });
    } catch (e) {
        console.error("Error drawing calendar:", e);
    }
}

// Ingestion (Drag/Drop & File Input)
function initIngestion() {
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");

    if (!dropZone) return;

    // Drag-over hover indicators
    ["dragenter", "dragover"].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.add("dragover");
        }, false);
    });

    ["dragleave", "drop"].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.remove("dragover");
        }, false);
    });

    dropZone.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleUploadedFile(files[0]);
        }
    });

    fileInput.addEventListener("change", (e) => {
        if (fileInput.files.length > 0) {
            handleUploadedFile(fileInput.files[0]);
        }
    });

    // Custom quick upload buttons mock
    document.getElementById("upload-sheets-btn").addEventListener("click", () => {
        triggerMockUpload(null, "Scanned Round Sheet");
    });
    document.getElementById("upload-photos-btn").addEventListener("click", () => {
        triggerMockUpload(null, "TMT Thermographic Image");
    });
    document.getElementById("upload-ncr-btn").addEventListener("click", () => {
        document.querySelector('[data-tab="manual"]').click();
    });
}

// Animate OCR progress and POST file
function handleUploadedFile(file) {
    const progressContainer = document.getElementById("upload-progress");
    const fill = document.getElementById("progress-bar-fill");
    const statusText = document.getElementById("ocr-status-text");
    const percentText = document.getElementById("progress-percent");

    progressContainer.style.display = "block";
    fill.style.width = "0%";
    percentText.innerText = "0%";

    const ocrSteps = [
        { pct: 15, text: "Deskewing scanned sheet coordinates..." },
        { pct: 40, text: "Locating anchor squares & QR headers..." },
        { pct: 70, text: "Extracting constrained handwriting comb boxes..." },
        { pct: 90, text: "Running confidence scoring & NLP parser..." },
        { pct: 100, text: "Parsing complete." }
    ];

    let currentStep = 0;
    const interval = setInterval(() => {
        if (currentStep < ocrSteps.length) {
            const step = ocrSteps[currentStep];
            fill.style.width = `${step.pct}%`;
            percentText.innerText = `${step.pct}%`;
            statusText.innerHTML = `<i class="fa-solid fa-sync fa-spin"></i> ${step.text}`;
            currentStep++;
        } else {
            clearInterval(interval);
            
            // Execute backend upload
            const formData = new FormData();
            formData.append("file", file);

            fetch("/api/upload", {
                method: "POST",
                body: formData
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    fetchSummary();
                    // Switch to validation tab
                    setTimeout(() => {
                        progressContainer.style.display = "none";
                        const validationTab = document.querySelector('[data-tab="validation"]');
                        validationTab.click();
                    }, 800);
                } else {
                    alert("Upload error: " + data.error);
                }
            })
            .catch(err => {
                console.error(err);
                alert("Upload failed. Check console.");
            });
        }
    }, 450);
}

// Trigger mock upload from calendar missing days click
function triggerMockUpload(day, filePrefix) {
    const monthSelect = document.getElementById("calendar-month-select");
    const yearSelect = document.getElementById("calendar-year-select");
    const mVal = monthSelect ? monthSelect.options[monthSelect.selectedIndex].text : "December";
    const yVal = yearSelect ? yearSelect.value : "2023";
    
    if (!filePrefix) {
        filePrefix = `${mVal} ${yVal} Package`;
    }

    if (!day) {
        day = 3;
    }

    const filename = `${day.toString().padStart(2, '0')}-${filePrefix} (Care Program).pdf`;
    
    // Simulate drop/selection progress bar
    const progressContainer = document.getElementById("upload-progress");
    const fill = document.getElementById("progress-bar-fill");
    const statusText = document.getElementById("ocr-status-text");
    const percentText = document.getElementById("progress-percent");

    progressContainer.style.display = "block";
    fill.style.width = "0%";
    percentText.innerText = "0%";

    const ocrSteps = [
        { pct: 20, text: `Opening file: ${filename}...` },
        { pct: 50, text: "Detecting grid structures and spatial alignment..." },
        { pct: 85, text: "Ingesting hand-written numbers and comments..." },
        { pct: 100, text: "OCR parsing complete." }
    ];

    let currentStep = 0;
    const interval = setInterval(() => {
        if (currentStep < ocrSteps.length) {
            const step = ocrSteps[currentStep];
            fill.style.width = `${step.pct}%`;
            percentText.innerText = `${step.pct}%`;
            statusText.innerHTML = `<i class="fa-solid fa-sync fa-spin"></i> ${step.text}`;
            currentStep++;
        } else {
            clearInterval(interval);
            
            // POST mock filename to API
            const bodyData = new URLSearchParams();
            bodyData.append("filename", filename);

            fetch("/api/upload", {
                method: "POST",
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: bodyData
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    fetchSummary();
                    setTimeout(() => {
                        progressContainer.style.display = "none";
                        document.querySelector('[data-tab="validation"]').click();
                    }, 800);
                }
            });
        }
    }, 400);
}

// Human-in-the-Loop Validation Cockpit
async function loadPendingValidations() {
    const emptyState = document.getElementById("validation-empty-state");
    const activeState = document.getElementById("validation-active-state");
    const badge = document.getElementById("pending-badge");

    try {
        const res = await fetch("/api/pending_validations");
        const pending = await res.json();
        
        // Update nav badge count
        if (pending.length > 0) {
            badge.innerText = pending.length;
            badge.style.display = "inline-block";
        } else {
            badge.style.display = "none";
        }

        if (pending.length === 0) {
            emptyState.style.display = "block";
            activeState.style.display = "none";
            return;
        }

        emptyState.style.display = "none";
        activeState.style.display = "grid";

        // Load the first pending item
        const item = pending[0];
        const sub = item.submission;
        const readings = item.readings;

        document.getElementById("scanned-filename").innerText = sub.filename;
        document.getElementById("validation-sub-id").value = sub.id;
        document.getElementById("validation-confidence-badge").innerText = `OCR Confidence: ${sub.confidence_rate}%`;

        // Dynamic Scanned Sheet Mock rendering
        const mockBody = document.querySelector(".sheet-body-mock");
        if (mockBody) {
            mockBody.innerHTML = "";
            readings.forEach((r, idx) => {
                if (r.tag_name === 'QMNUM_LONGTEXT') return;
                
                const mRow = document.createElement("div");
                mRow.className = "mock-row";
                mRow.id = `mock-row-${idx}`;
                
                const parsedDay = parseInt(sub.parsed_date.split('-')[2]);
                if (parsedDay === 25 && r.tag_name === 'GM1503_SEAL_POT_LVL.PV') {
                    mRow.className = "mock-row alert-bg animate-pulse";
                    mRow.style.borderLeft = "3px solid var(--color-warning)";
                    mRow.innerHTML = `
                        <span class="mock-lbl"><i class="fa-solid fa-water" style="color:var(--color-warning);"></i> Smudge Area (${r.parameter}):</span>
                        <span class="mock-comb smudged" style="color:var(--color-warning); font-weight:700;">[ ? ].[ ? ][ ? ]</span>
                    `;
                } else {
                    mRow.innerHTML = `
                        <span class="mock-lbl">${r.parameter}:</span>
                        <span class="mock-comb">[ ${r.value} ] ${r.unit || ''}</span>
                    `;
                }
                mockBody.appendChild(mRow);
            });
        }

        // Render Data Grid editor fields
        const grid = document.getElementById("validation-fields-grid");
        grid.innerHTML = "";

        readings.forEach(r => {
            if (r.tag_name === 'QMNUM_LONGTEXT') {
                // Comments loaded in textarea below, skip in numeric grid
                document.getElementById("validation-comment").value = r.value || "";
                return;
            }

            const row = document.createElement("div");
            row.classList.add("editor-row");
            if (r.confidence < 85.0) {
                row.classList.add("low-confidence");
            }

            row.innerHTML = `
                <div class="field-label">
                    <span class="field-name">${r.parameter}</span>
                    <span class="field-tag">${r.tag_name}</span>
                </div>
                <div class="input-container">
                    <input type="text" class="form-control val-input" data-tag="${r.tag_name}" value="${r.value}">
                    <span class="unit-label">${r.unit}</span>
                </div>
                <div class="confidence-indicator">
                    <span class="confidence-pct ${r.confidence >= 85.0 ? 'green' : 'orange'}">${r.confidence}%</span>
                    <span class="confidence-lbl">Certainty</span>
                </div>
            `;
            grid.appendChild(row);
        });

        // Add form handlers
        const form = document.getElementById("validation-form");
        form.onsubmit = async (e) => {
            e.preventDefault();
            
            const payload = {};
            const valInputs = form.querySelectorAll(".val-input");
            valInputs.forEach(input => {
                payload[input.getAttribute("data-tag")] = input.value;
            });
            payload['QMNUM_LONGTEXT'] = document.getElementById("validation-comment").value;

            const res = await fetch(`/api/validate_submission/${sub.id}`, {
                method: "POST",
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                fetchSummary();
                loadPendingValidations();
                loadPrescriptions();
            }
        };

        document.getElementById("reject-submission-btn").onclick = async () => {
            if (confirm("Are you sure you want to discard this scanned document? It will delete the pending values.")) {
                // Simple deletion of pending (not committed) records is handled implicitly or can skip.
                // We'll reload validation which clears it or mocks resolution
                alert("Scan discarded.");
                location.reload();
            }
        };

    } catch (e) {
        console.error("Error loading validations:", e);
    }
}

// Custom Trending Cockpit Controller
let availableTags = [];
async function initTrending() {
    try {
        const res = await fetch("/api/tags");
        availableTags = await res.json();

        // 1. Populate checkboxes
        const list = document.getElementById("trending-tag-list");
        if (!list) return;
        list.innerHTML = "";

        availableTags.forEach((tag, idx) => {
            const item = document.createElement("label");
            item.classList.add("checkbox-item");
            
            // Default check the first two variables (Total Feed and TLE Temp)
            const isDefault = tag.tag_name === 'TOTAL_FEED.PV' || tag.tag_name === 'TLE_TEMP.PV';

            item.innerHTML = `
                <input type="checkbox" class="tag-checkbox" value="${tag.tag_name}" ${isDefault ? 'checked' : ''}>
                <span>${tag.parameter} (${tag.tag_name})</span>
            `;
            list.appendChild(item);
        });

        // Limit maximum checkboxes to 5
        const checkboxes = document.querySelectorAll(".tag-checkbox");
        checkboxes.forEach(cb => {
            cb.addEventListener("change", () => {
                const checked = document.querySelectorAll(".tag-checkbox:checked");
                
                if (checked.length >= maxSelectedTags) {
                    checkboxes.forEach(item => {
                        if (!item.checked) item.disabled = true;
                    });
                } else {
                    checkboxes.forEach(item => item.disabled = false);
                }

                updateAxisConfigurations();
                loadChartData();
            });
        });

        // 2. Aggregation buttons
        const aggButtons = document.querySelectorAll("[data-interval]");
        aggButtons.forEach(btn => {
            btn.addEventListener("click", () => {
                aggButtons.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                selectedInterval = btn.getAttribute("data-interval");
                loadChartData();
            });
        });

        // 3. Reset chart scale button
        document.getElementById("reset-zoom-btn").addEventListener("click", () => {
            // Re-render Y axis configurations to auto and load
            const configs = document.querySelectorAll(".axis-autoscale-cb");
            configs.forEach(cb => cb.checked = true);
            const minInputs = document.querySelectorAll(".axis-min-input");
            minInputs.forEach(i => { i.value = ""; i.disabled = true; });
            const maxInputs = document.querySelectorAll(".axis-max-input");
            maxInputs.forEach(i => { i.value = ""; i.disabled = true; });
            
            loadChartData();
        });

        // Update active variables limits editor
        updateAxisConfigurations();

    } catch (e) {
        console.error(e);
    }
}

// Generate the configuration inputs for axes min/max bounds
function updateAxisConfigurations() {
    const container = document.getElementById("axis-config-container");
    if (!container) return;
    container.innerHTML = "";

    const checked = document.querySelectorAll(".tag-checkbox:checked");
    
    // Preset line colors for Chart.js matching config lines
    const colors = ["#0ea5e9", "#10b981", "#f59e0b", "#f43f5e", "#a855f7"];

    checked.forEach((cb, idx) => {
        const tagName = cb.value;
        const tag = availableTags.find(t => t.tag_name === tagName);
        if (!tag) return;

        const color = colors[idx % colors.length];

        const item = document.createElement("div");
        item.classList.add("axis-config-item");
        item.style.borderLeftColor = color;

        item.innerHTML = `
            <div class="axis-config-header">
                <span title="${tag.parameter}">${tag.parameter}</span>
                <span style="color: ${color}"><i class="fa-solid fa-square-full"></i></span>
            </div>
            <div class="axis-config-inputs">
                <label>
                    <input type="checkbox" class="axis-autoscale-cb" data-tag="${tagName}" checked>
                    <span>Auto</span>
                </label>
                <div>
                    <input type="number" class="axis-min-input" data-tag="${tagName}" placeholder="Min" disabled>
                </div>
                <div>
                    <input type="number" class="axis-max-input" data-tag="${tagName}" placeholder="Max" disabled>
                </div>
            </div>
        `;
        container.appendChild(item);
    });

    // Add event listeners on new axis configuration checkboxes & inputs
    const autoscales = container.querySelectorAll(".axis-autoscale-cb");
    autoscales.forEach(cb => {
        cb.addEventListener("change", () => {
            const tag = cb.getAttribute("data-tag");
            const minInput = container.querySelector(`.axis-min-input[data-tag="${tag}"]`);
            const maxInput = container.querySelector(`.axis-max-input[data-tag="${tag}"]`);
            
            if (cb.checked) {
                minInput.disabled = true;
                maxInput.disabled = true;
                minInput.value = "";
                maxInput.value = "";
            } else {
                minInput.disabled = false;
                maxInput.disabled = false;
            }
            loadChartData();
        });
    });

    const valInputs = container.querySelectorAll(".axis-min-input, .axis-max-input");
    valInputs.forEach(input => {
        input.addEventListener("change", loadChartData);
    });
}

// Query and draw the Multi-Y-Axis Chart
async function loadChartData() {
    const checked = Array.from(document.querySelectorAll(".tag-checkbox:checked")).map(cb => cb.value);
    if (checked.length === 0) {
        if (trendingChart) trendingChart.destroy();
        return;
    }

    try {
        const res = await fetch(`/api/tag_history?tags=${checked.join(',')}&interval=${selectedInterval}`);
        const historyData = await res.json();

        const colors = ["#0ea5e9", "#10b981", "#f59e0b", "#f43f5e", "#a855f7"];
        
        if (trendingChart) {
            trendingChart.destroy();
        }

        // Collect unique timestamps from both history and forecast to align x-axis
        let allTimes = new Set();
        checked.forEach(tag => {
            if (historyData[tag]) {
                if (historyData[tag].history) {
                    historyData[tag].history.forEach(item => allTimes.add(item.time));
                }
                if (historyData[tag].forecast) {
                    historyData[tag].forecast.forEach(item => allTimes.add(item.time));
                }
            }
        });
        const labels = Array.from(allTimes).sort();

        // Build datasets and axes
        const datasets = [];
        const isDarkMode = document.body.classList.contains("dark-mode");
        const chartGridColor = isDarkMode ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
        const chartTickColor = isDarkMode ? "#94a3b8" : "#475569";
        const chartLegendColor = isDarkMode ? "#e2e8f0" : "#1e293b";

        const scales = {
            x: {
                grid: { color: chartGridColor },
                ticks: { color: chartTickColor, font: { family: "Outfit" } }
            }
        };

        checked.forEach((tag, idx) => {
            const tagMeta = availableTags.find(t => t.tag_name === tag);
            if (!tagMeta) return;

            const color = colors[idx % colors.length];
            const axisId = `y_axis_${idx + 1}`;

            const histList = historyData[tag]?.history || [];
            const foreList = historyData[tag]?.forecast || [];

            // Map actual history points
            const actualPoints = labels.map(time => {
                const found = histList.find(item => item.time === time);
                return found ? found.value : null;
            });

            // Map forecast points (including last actual point to connect lines)
            const lastHistItem = histList.length > 0 ? histList[histList.length - 1] : null;
            const forecastPoints = labels.map(time => {
                const foundFore = foreList.find(item => item.time === time);
                if (foundFore) return foundFore.value;
                if (lastHistItem && lastHistItem.time === time) return lastHistItem.value;
                return null;
            });

            // Add actual dataset (solid)
            datasets.push({
                label: `${tagMeta.parameter} (Actual)`,
                data: actualPoints,
                borderColor: color,
                backgroundColor: color + "1A", // 10% opacity
                borderWidth: 2,
                yAxisID: axisId,
                spanGaps: true,
                tension: 0.2
            });

            // Add forecast dataset (dashed)
            if (foreList.length > 0) {
                datasets.push({
                    label: `${tagMeta.parameter} (Forecast)`,
                    data: forecastPoints,
                    borderColor: color,
                    backgroundColor: "transparent",
                    borderWidth: 2,
                    borderDash: [5, 5],
                    yAxisID: axisId,
                    spanGaps: true,
                    tension: 0.2
                });
            }

            // Configure axis scale properties
            const autoscaleCb = document.querySelector(`.axis-autoscale-cb[data-tag="${tag}"]`);
            const autoscale = autoscaleCb ? autoscaleCb.checked : true;
            const minVal = document.querySelector(`.axis-min-input[data-tag="${tag}"]`)?.value;
            const maxVal = document.querySelector(`.axis-max-input[data-tag="${tag}"]`)?.value;

            scales[axisId] = {
                type: 'linear',
                display: true,
                position: idx % 2 === 0 ? 'left' : 'right',
                grid: {
                    drawOnChartArea: idx === 0, // only show grid lines for the first axis to avoid clutter
                    color: chartGridColor
                },
                ticks: {
                    color: color,
                    font: { family: "Outfit" }
                },
                title: {
                    display: true,
                    text: tagMeta.unit,
                    color: color,
                    font: { family: "Outfit", weight: "bold" }
                }
            };

            // Set manual bounds if autoscale is disabled
            if (!autoscale) {
                if (minVal !== undefined && minVal !== "") {
                    scales[axisId].min = parseFloat(minVal);
                }
                if (maxVal !== undefined && maxVal !== "") {
                    scales[axisId].max = parseFloat(maxVal);
                }
            }
        });

        // Initialize Chart
        const ctx = document.getElementById('trendingChart').getContext('2d');
        trendingChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { color: chartLegendColor, font: { family: "Outfit", size: 12, weight: "500" } }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: scales
            }
        });

    } catch (e) {
        console.error("Error drawing trend chart:", e);
    }
}

// Insights & Diagnostics Cockpit
let mainPrescriptionFilter = "All";

function initPrescriptionsFilter() {
    const criticalCard = document.getElementById("summary-metric-critical");
    const warningCard = document.getElementById("summary-metric-warning");
    const resolvedCard = document.getElementById("summary-metric-resolved");

    if (criticalCard) {
        criticalCard.onclick = () => {
            mainPrescriptionFilter = mainPrescriptionFilter === 'Critical' ? 'All' : 'Critical';
            loadPrescriptions();
        };
    }
    if (warningCard) {
        warningCard.onclick = () => {
            mainPrescriptionFilter = mainPrescriptionFilter === 'Warning' ? 'All' : 'Warning';
            loadPrescriptions();
        };
    }
    if (resolvedCard) {
        resolvedCard.onclick = () => {
            mainPrescriptionFilter = mainPrescriptionFilter === 'Resolved' ? 'All' : 'Resolved';
            loadPrescriptions();
        };
    }
}

async function loadPrescriptions() {
    const list = document.getElementById("prescriptions-list");
    if (!list) return;
    list.innerHTML = "";

    try {
        const res = await fetch("/api/prescriptions");
        const data = await res.json();

        const active = data.filter(p => p.status === 'Active');
        const resolved = data.filter(p => p.status === 'Resolved');

        document.getElementById("critical-alert-count").innerText = active.filter(p => p.severity === 'Critical').length;
        document.getElementById("warning-alert-count").innerText = active.filter(p => p.severity === 'Warning').length;
        document.getElementById("resolved-alert-count").innerText = resolved.length;

        // Update active class on filter cards
        const metricCards = {
            'Critical': document.getElementById("summary-metric-critical"),
            'Warning': document.getElementById("summary-metric-warning"),
            'Resolved': document.getElementById("summary-metric-resolved")
        };

        Object.keys(metricCards).forEach(key => {
            const card = metricCards[key];
            if (card) {
                if (mainPrescriptionFilter === key) {
                    card.classList.add("active");
                } else {
                    card.classList.remove("active");
                }
            }
        });

        const panelActions = active.filter(p => p.type === 'Panel Action');
        const fieldActions = active.filter(p => p.type === 'Field Action');
        const panelCountEl = document.getElementById("panel-action-count");
        const fieldCountEl = document.getElementById("field-action-count");
        if (panelCountEl) panelCountEl.innerText = panelActions.length;
        if (fieldCountEl) fieldCountEl.innerText = fieldActions.length;

        // Apply mainPrescriptionFilter filtering
        let activeToRender = active;
        let resolvedToRender = resolved;

        if (mainPrescriptionFilter === 'Critical') {
            activeToRender = active.filter(p => p.severity === 'Critical');
            resolvedToRender = [];
        } else if (mainPrescriptionFilter === 'Warning') {
            activeToRender = active.filter(p => p.severity === 'Warning');
            resolvedToRender = [];
        } else if (mainPrescriptionFilter === 'Resolved') {
            activeToRender = [];
            resolvedToRender = resolved;
        }

        if (activeToRender.length === 0 && resolvedToRender.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-square-check empty-icon" style="color: var(--color-success)"></i>
                    <h3>No matching prescriptions found</h3>
                    <p>Select another category or reset filters to display more insights.</p>
                </div>
            `;
            return;
        }

        // Render Active prescriptions
        activeToRender.forEach(p => {
            const card = document.createElement("div");
            card.classList.add("prescription-card", p.severity.toLowerCase());
            
            const typeClass = p.type.toLowerCase().replace(' ', '-');
            card.innerHTML = `
                <div class="prescription-content">
                    <div class="prescription-meta">
                        <span class="severity-badge ${p.severity.toLowerCase()}">${p.severity}</span>
                        <span class="severity-badge ${typeClass}">${p.type}</span>
                        <span class="asset-badge">${p.asset_id}</span>
                        <span class="prescription-date">${p.created_at.split(' ')[0]}</span>
                    </div>
                    <h4><i class="fa-solid fa-triangle-exclamation"></i> ${p.insight}</h4>
                    <div class="prescription-action">
                        <strong>Prescription:</strong> ${p.prescription}
                    </div>
                </div>
                <button class="btn btn-secondary btn-tab" onclick="resolvePrescription(${p.id})">Resolve</button>
            `;
            list.appendChild(card);
        });

        // Render Resolved prescriptions (grayed out)
        resolvedToRender.forEach(p => {
            const card = document.createElement("div");
            card.classList.add("prescription-card", "resolved");
            
            const typeClass = p.type.toLowerCase().replace(' ', '-');
            card.innerHTML = `
                <div class="prescription-content">
                    <div class="prescription-meta">
                        <span class="severity-badge resolved">Resolved</span>
                        <span class="severity-badge ${typeClass}">${p.type}</span>
                        <span class="asset-badge">${p.asset_id}</span>
                        <span class="prescription-date">Closed</span>
                    </div>
                    <h4>${p.insight}</h4>
                    <div class="prescription-action" style="border-left-color: var(--text-muted)">
                        <strong>Recommendation Executed:</strong> ${p.prescription}
                    </div>
                </div>
            `;
            list.appendChild(card);
        });

        // Initialize category interactive box
        initCategoryPrescriptions(data);

    } catch (e) {
        console.error(e);
    }
}

let activeCategoryFilter = null;
let activeSeverityFilter = "All";

function initCategoryPrescriptions(allPrescriptions) {
    const panelCard = document.getElementById("kpi-panel-actions");
    const fieldCard = document.getElementById("kpi-field-actions");
    const container = document.getElementById("category-prescriptions-box");
    const list = document.getElementById("category-prescriptions-list");
    const title = document.getElementById("category-prescriptions-title");
    
    if (!panelCard || !fieldCard || !container) return;
    
    const resetActiveStyle = () => {
        panelCard.style.transform = "scale(1)";
        panelCard.style.boxShadow = "none";
        panelCard.style.border = "1px solid var(--border-color)";
        panelCard.style.borderLeft = "3px solid #8b5cf6";
        
        fieldCard.style.transform = "scale(1)";
        fieldCard.style.boxShadow = "none";
        fieldCard.style.border = "1px solid var(--border-color)";
        fieldCard.style.borderLeft = "3px solid #14b8a6";
    };
    
    const renderFilteredList = (category) => {
        let filtered = allPrescriptions.filter(p => p.status === 'Active' && p.type === category);
        
        if (activeSeverityFilter !== "All") {
            filtered = filtered.filter(p => p.severity === activeSeverityFilter);
        }
        
        list.innerHTML = "";
        
        if (filtered.length === 0) {
            list.innerHTML = `<p class="text-muted" style="font-size: 11px; padding: 10px 0;"><i class="fa-solid fa-circle-info"></i> No active ${activeSeverityFilter.toLowerCase()} prescriptions for this category.</p>`;
        } else {
            filtered.forEach(p => {
                const item = document.createElement("div");
                item.className = `prescription-item-modal ${p.severity.toLowerCase()}`;
                item.style.background = "rgba(255,255,255,0.02)";
                item.style.padding = "10px 14px";
                item.style.borderRadius = "6px";
                item.style.border = "1px solid var(--border-color)";
                
                let borderLeftColor = "var(--color-success)";
                if (p.severity.toLowerCase() === 'critical') borderLeftColor = "var(--color-danger)";
                else if (p.severity.toLowerCase() === 'warning') borderLeftColor = "var(--color-warning)";
                item.style.borderLeft = `3px solid ${borderLeftColor}`;
                
                item.innerHTML = `
                    <div style="font-weight: bold; margin-bottom: 4px; display: flex; justify-content: space-between; font-size: 11px;">
                        <span><strong>Asset: ${p.asset_id}</strong></span>
                        <span class="badge ${p.severity.toLowerCase() === 'critical' ? 'danger' : 'warning'}">${p.severity}</span>
                    </div>
                    <div style="font-size: 11px; margin-bottom: 4px; color: var(--text-muted);"><strong>Deviation:</strong> ${p.insight}</div>
                    <div style="font-size: 11px; color: var(--text-main);"><strong>Action:</strong> ${p.prescription}</div>
                `;
                list.appendChild(item);
            });
        }
    };
    
    const showCategory = (category) => {
        if (activeCategoryFilter === category) {
            activeCategoryFilter = null;
            container.style.display = "none";
            resetActiveStyle();
            return;
        }
        
        activeCategoryFilter = category;
        container.style.display = "block";
        resetActiveStyle();
        
        if (category === "Panel Action") {
            panelCard.style.transform = "scale(1.02)";
            panelCard.style.boxShadow = "0 0 15px rgba(139, 92, 246, 0.25)";
            panelCard.style.border = "1px solid #a78bfa";
            panelCard.style.borderLeft = "3px solid #a78bfa";
            title.innerHTML = `<i class="fa-solid fa-sliders" style="color: #a78bfa;"></i> Active Panel Action Prescriptions`;
        } else {
            fieldCard.style.transform = "scale(1.02)";
            fieldCard.style.boxShadow = "0 0 15px rgba(20, 184, 166, 0.25)";
            fieldCard.style.border = "1px solid #2dd4bf";
            fieldCard.style.borderLeft = "3px solid #2dd4bf";
            title.innerHTML = `<i class="fa-solid fa-wrench" style="color: #2dd4bf;"></i> Active Field Action Prescriptions`;
        }
        
        renderFilteredList(category);
    };
    
    // Bind severity pill filters
    const pills = document.querySelectorAll(".sev-filter-pill");
    pills.forEach(pill => {
        // Sync active class
        pill.classList.remove("active");
        if (pill.getAttribute("data-sev") === activeSeverityFilter) {
            pill.classList.add("active");
        }
        
        pill.onclick = (e) => {
            e.stopPropagation();
            activeSeverityFilter = pill.getAttribute("data-sev");
            
            pills.forEach(pl => pl.classList.remove("active"));
            pill.classList.add("active");
            
            if (activeCategoryFilter) {
                renderFilteredList(activeCategoryFilter);
            }
        };
    });
    
    panelCard.onclick = () => showCategory("Panel Action");
    fieldCard.onclick = () => showCategory("Field Action");
    
    // Auto-refresh if active filter is already selected
    if (activeCategoryFilter) {
        renderFilteredList(activeCategoryFilter);
    }
}

// Resolve prescription action
async function resolvePrescription(pId) {
    try {
        const res = await fetch(`/api/prescriptions/${pId}/resolve`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            loadPrescriptions();
            fetchSummary();
        }
    } catch (e) {
        console.error(e);
    }
}

// Manual rounds entry form
function initManualEntry() {
    const form = document.getElementById("manual-entry-form");
    if (!form) return;

    // Set default timestamp to now
    const now = new Date();
    const localISO = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById("manual-timestamp").value = localISO;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const ts = document.getElementById("manual-timestamp").value.replace('T', ' ') + ':00';
        const payload = {
            timestamp: ts,
            values: {
                "TOTAL_FEED.PV": document.getElementById("m-total-feed").value,
                "FRESH_FEED.PV": document.getElementById("m-fresh-feed").value,
                "TLE_TEMP.PV": document.getElementById("m-tle-temp").value,
                "GT1501_DIS_PRESS.PV": document.getElementById("m-gt1501-press").value,
                "GT1503_DIS_PRESS.PV": document.getElementById("m-gt1503-press").value,
                "GM1503_SEAL_POT_LVL.PV": document.getElementById("m-gm1503-level").value,
                "QMNUM_LONGTEXT": document.getElementById("m-comments").value
            }
        };

        const res = await fetch("/api/manual_entry", {
            method: "POST",
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            alert("Manual rounds logged successfully. Re-running diagnostic engines...");
            form.reset();
            document.getElementById("manual-timestamp").value = localISO;
            fetchSummary();
            loadPrescriptions();
        }
    });
}

// Load Preset Scenarios into manual input form for testing
function loadScenario(type) {
    const localISO = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById("manual-timestamp").value = localISO;

    if (type === 'pump-drift') {
        document.getElementById("m-total-feed").value = "202.0";
        document.getElementById("m-fresh-feed").value = "135.0";
        document.getElementById("m-tle-temp").value = "321.0"; // TLE Temp drift (Limit: 320.0)
        document.getElementById("m-gt1501-press").value = "2800";
        document.getElementById("m-gt1503-press").value = "2700";
        document.getElementById("m-gm1503-level").value = "100";
        document.getElementById("m-comments").value = "E-1203 B (TLE temp high 321) coils temperature reduced to control overheating.";
    } else if (type === 'compressor-spike') {
        document.getElementById("m-total-feed").value = "202.0";
        document.getElementById("m-fresh-feed").value = "135.0";
        document.getElementById("m-tle-temp").value = "318.0";
        document.getElementById("m-gt1501-press").value = "2800";
        document.getElementById("m-gt1503-press").value = "2700";
        document.getElementById("m-gm1503-level").value = "42"; // Low level anomaly (Limit: 50)
        document.getElementById("m-comments").value = "GM-1503 seal pot level dropped to 42%. Checked casing and gland seal.";
    } else if (type === 'flame-deflection') {
        document.getElementById("m-total-feed").value = "202.0";
        document.getElementById("m-fresh-feed").value = "135.0";
        document.getElementById("m-tle-temp").value = "318.0";
        document.getElementById("m-gt1501-press").value = "2800";
        document.getElementById("m-gt1503-press").value = "2700";
        document.getElementById("m-gm1503-level").value = "100";
        document.getElementById("m-comments").value = "Compressor bearing lubrication alert: K-1402 need add oil immediately.";
    }
    
    alert("Test Scenario pre-filled. Click 'Submit Manual Ingestion' below to commit it.");
}

// Revamped Javascript functions for Audit & Analytics Tab
async function loadAnalyticsTab() {
    loadHeatmap();
    loadCorrelations();
    loadOutliers();
    loadShiftEvents();
}

async function loadHeatmap() {
    const grid = document.getElementById("tmt-heatmap-grid");
    if (!grid) return;
    grid.innerHTML = "Loading TMT heatmap...";
    
    try {
        const res = await fetch("/api/analytics/tmt_heatmap");
        const data = await res.json();
        
        grid.innerHTML = "";
        const heaters = [];
        for (let i = 1; i <= 12; i++) {
            const numStr = (1200 + i).toString();
            heaters.push({
                tag: `B${numStr}_COIL_TEMP.PV`,
                label: `B-${numStr}`
            });
        }
        
        heaters.forEach(h => {
            const rowDiv = document.createElement("div");
            rowDiv.classList.add("heatmap-row");
            
            const labelSpan = document.createElement("span");
            labelSpan.classList.add("heatmap-label");
            labelSpan.innerText = h.label;
            rowDiv.appendChild(labelSpan);
            
            const cellsDiv = document.createElement("div");
            cellsDiv.classList.add("heatmap-cells");
            
            for (let day = 1; day <= 30; day++) {
                const dateKey = `2023-12-${day.toString().padStart(2, '0')}`;
                const cell = document.createElement("div");
                cell.classList.add("heatmap-cell");
                
                let temp = null;
                if (data[dateKey] && data[dateKey][h.tag] !== undefined) {
                    temp = data[dateKey][h.tag];
                }
                
                if (temp === null) {
                    cell.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
                    cell.setAttribute("data-tooltip", `Dec ${day}: No Ingested Data`);
                } else {
                    if (temp >= 1020.0) {
                        cell.style.backgroundColor = "#ef4444"; // Red
                    } else if (temp >= 990.0) {
                        cell.style.backgroundColor = "#f59e0b"; // Yellow
                    } else {
                        cell.style.backgroundColor = "#10b981"; // Green
                    }
                    cell.setAttribute("data-tooltip", `Dec ${day}: ${temp.toFixed(1)} °C`);
                }
                cellsDiv.appendChild(cell);
            }
            rowDiv.appendChild(cellsDiv);
            grid.appendChild(rowDiv);
        });
    } catch (e) {
        grid.innerHTML = `<span class="text-danger">Failed to load TMT heatmap data: ${e.message}</span>`;
    }
}

async function loadCorrelations() {
    const tableBody = document.getElementById("correlation-table-body");
    const headerRow = document.getElementById("corr-table-header");
    if (!tableBody || !headerRow) return;
    
    tableBody.innerHTML = "Loading correlations...";
    headerRow.innerHTML = "";
    
    try {
        const res = await fetch("/api/analytics/correlations");
        const matrix = await res.json();
        
        const tags = Object.keys(matrix);
        if (tags.length === 0) {
            tableBody.innerHTML = "<tr><td colspan='6'>No statistical correlations calculated. Ingest more data.</td></tr>";
            return;
        }
        
        const names = {
            "TOTAL_FEED.PV": "Total Feed",
            "FRESH_FEED.PV": "Fresh Feed",
            "TLE_TEMP.PV": "TLE Temp",
            "GT1501_DIS_PRESS.PV": "GT-1501 Press",
            "GM1503_SEAL_POT_LVL.PV": "GM-1503 Lvl"
        };
        
        headerRow.innerHTML = "<th>Variable</th>" + tags.map(t => `<th>${names[t] || t}</th>`).join("");
        
        tableBody.innerHTML = "";
        tags.forEach(t1 => {
            const tr = document.createElement("tr");
            tr.innerHTML = `<td><strong>${names[t1] || t1}</strong></td>`;
            tags.forEach(t2 => {
                const r = matrix[t1][t2];
                let valClass = "correlation-val-mod";
                if (r > 0.4) valClass = "correlation-val-high";
                else if (r < -0.4) valClass = "correlation-val-neg";
                tr.innerHTML += `<td class="${valClass}">${r.toFixed(3)}</td>`;
            });
            tableBody.appendChild(tr);
        });
    } catch (e) {
        tableBody.innerHTML = `<tr><td colspan='6' class='text-danger'>Error: ${e.message}</td></tr>`;
    }
}

async function loadOutliers() {
    const tbody = document.getElementById("outliers-table-body");
    if (!tbody) return;
    tbody.innerHTML = "<tr><td colspan='4'>Loading outlier anomalies...</td></tr>";
    
    try {
        const res = await fetch("/api/analytics/outliers");
        const data = await res.json();
        
        if (data.length === 0) {
            tbody.innerHTML = "<tr><td colspan='4' class='text-success'>No statistical outliers detected. Asset boundaries healthy.</td></tr>";
            return;
        }
        
        tbody.innerHTML = "";
        data.forEach(item => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${item.date}</td>
                <td>${item.parameter}</td>
                <td><strong>${item.value.toFixed(1)} ${item.unit}</strong></td>
                <td><span class="text-danger"><i class="fa-solid fa-circle-exclamation"></i> ${item.reason}</span></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan='4' class='text-danger'>Error: ${e.message}</td></tr>`;
    }
}

async function loadShiftEvents() {
    const tbody = document.getElementById("events-table-body");
    if (!tbody) return;
    
    const catFilter = document.getElementById("auditor-cat-filter").value;
    const searchVal = document.getElementById("auditor-search-input").value;
    
    tbody.innerHTML = "<tr><td colspan='5'>Loading shift supervisor log auditor...</td></tr>";
    
    try {
        const url = `/api/events?category=${catFilter}&search=${encodeURIComponent(searchVal)}`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.length === 0) {
            tbody.innerHTML = "<tr><td colspan='5' class='text-muted'>No matching shift events found.</td></tr>";
            return;
        }
        
        tbody.innerHTML = "";
        data.forEach(item => {
            const tr = document.createElement("tr");
            const catClass = item.category.toLowerCase().replace(" ", "_");
            const dateOnly = item.timestamp.split(" ")[0];
            
            tr.innerHTML = `
                <td>${dateOnly}</td>
                <td><span class="badge-category ${catClass}">${item.category}</span></td>
                <td><strong>${item.equipment_id}</strong></td>
                <td title="${item.event_text}">${item.event_text}</td>
                <td>${item.work_order !== 'None' ? `<span class="text-info font-monospace">${item.work_order}</span>` : '<span class="text-muted">-</span>'}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan='5' class='text-danger'>Error: ${e.message}</td></tr>`;
    }
}

// Bind search and filter events for auditor
document.addEventListener("DOMContentLoaded", () => {
    const filter = document.getElementById("auditor-cat-filter");
    const input = document.getElementById("auditor-search-input");
    
    if (filter) {
        filter.addEventListener("change", loadShiftEvents);
    }
    if (input) {
        let debounceTimer;
        input.addEventListener("input", () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(loadShiftEvents, 300);
        });
    }
});

async function fetchOptimizationStatus() {
    const yieldVal = document.getElementById("opt-yield-val");
    const energyVal = document.getElementById("opt-energy-val");
    const safetyVal = document.getElementById("opt-safety-val");
    const safetySubtext = document.getElementById("opt-safety-subtext");
    const optBadge = document.getElementById("opt-status-badge");
    const recText = document.getElementById("opt-recommendation-text");
    const recBox = document.getElementById("opt-recommendation-box");
    const safetyCard = document.getElementById("opt-safety-card");
    const safetyIcon = document.getElementById("opt-safety-icon");

    if (!yieldVal) return;

    try {
        const res = await fetch("/api/optimization_status");
        const data = await res.json();

        yieldVal.innerText = `${data.yield.toFixed(2)} %`;
        energyVal.innerText = `${data.specific_energy.toFixed(2)} GCal/t`;
        safetyVal.innerText = data.status;
        recText.innerText = data.description;

        if (data.status === "OPTIMAL") {
            optBadge.className = "optimization-status-badge";
            optBadge.innerHTML = `<span class="pulse-green"></span><span class="badge-label" id="opt-status-label">OPTIMAL CONTROL</span>`;
            
            safetySubtext.innerText = "All equipment status OK";
            safetyCard.className = "kpi-card mini";
            if (safetyIcon) safetyIcon.innerHTML = `<i class="fa-solid fa-shield-halved" style="color: #10b981;"></i>`;
            
            recBox.className = "optimization-recommendation";
        } else {
            optBadge.className = "optimization-status-badge blocked";
            optBadge.innerHTML = `<span class="pulse-red"></span><span class="badge-label" id="opt-status-label">BLOCKED (UNSAFE)</span>`;
            
            safetySubtext.innerText = `${data.active_alerts} active warning(s)`;
            safetyCard.className = "kpi-card mini highlight";
            if (safetyIcon) safetyIcon.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #ef4444;"></i>`;
            
            recBox.className = "optimization-recommendation blocked";
        }
    } catch (e) {
        console.error("Error fetching optimization status:", e);
    }
}

async function openDayModal(dateStr) {
    const modal = document.getElementById("day-detail-modal");
    if (!modal) return;
    
    const dateParts = dateStr.split('-');
    const year = dateParts[0];
    const month = dateParts[1];
    const day = parseInt(dateParts[2]);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const formattedMonth = monthNames[parseInt(month) - 1];
    
    document.getElementById("modal-date-title").innerText = `Plant Logs & Prescriptions - ${formattedMonth} ${day}, ${year}`;
    document.getElementById("modal-parameters-body").innerHTML = "<tr><td colspan='4'>Loading parameters...</td></tr>";
    document.getElementById("modal-comments-text").innerText = "Loading supervisor shift comments...";
    document.getElementById("modal-prescriptions-list").innerHTML = "<p>Loading prescriptions...</p>";
    document.getElementById("modal-checklist-body").innerHTML = "<tr><td colspan='3'>Loading checks...</td></tr>";
    
    modal.style.display = "flex";
    
    try {
        const res = await fetch(`/api/day_details?date=${dateStr}`);
        const data = await res.json();
        
        if (data.error) {
            alert(data.error);
            closeDayModal();
            return;
        }
        
        const paramBody = document.getElementById("modal-parameters-body");
        paramBody.innerHTML = "";
        data.readings.forEach(r => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><strong>${r.parameter}</strong></td>
                <td>${r.tag_name}</td>
                <td><strong>${r.value} ${r.unit}</strong></td>
                <td><span class="text-muted">${r.limit_value} ${r.unit} (${r.limit_type})</span></td>
            `;
            paramBody.appendChild(tr);
        });
        
        const commentsText = data.comments || "No comments logged for this shift.";
        const commentsContainer = document.getElementById("modal-comments-text");
        commentsContainer.innerHTML = "";
        
        if (commentsText.includes(" | ")) {
            const list = document.createElement("ul");
            list.style.margin = "0";
            list.style.paddingLeft = "20px";
            list.style.lineHeight = "1.6";
            
            commentsText.split(" | ").forEach(part => {
                if (part.trim()) {
                    const li = document.createElement("li");
                    li.innerText = part.trim();
                    list.appendChild(li);
                }
            });
            commentsContainer.appendChild(list);
        } else {
            commentsContainer.innerText = commentsText;
        }
        
        const prescList = document.getElementById("modal-prescriptions-list");
        prescList.innerHTML = "";
        
        if (data.prescriptions.length === 0) {
            prescList.innerHTML = `<p class="text-success"><i class="fa-solid fa-circle-check"></i> No active prescriptions. Safety boundaries normal.</p>`;
        } else {
            data.prescriptions.forEach(p => {
                const pDiv = document.createElement("div");
                pDiv.className = `prescription-item-modal ${p.severity.toLowerCase()}`;
                pDiv.innerHTML = `
                    <div style="font-weight: bold; margin-bottom: 4px;">
                        <span class="badge ${p.severity.toLowerCase() === 'critical' ? 'danger' : 'warning'}" style="margin-right:6px;">${p.severity}</span>
                        ${p.type} on asset ${p.asset_id}
                    </div>
                    <div style="margin-bottom: 4px;"><strong>Deviation:</strong> ${p.insight}</div>
                    <div><strong>Operator Action:</strong> ${p.prescription}</div>
                `;
                prescList.appendChild(pDiv);
            });
        }
        
        const checkBody = document.getElementById("modal-checklist-body");
        checkBody.innerHTML = "";
        if (data.checklist && data.checklist.length > 0) {
            data.checklist.forEach(c => {
                const tr = document.createElement("tr");
                let badgeClass = "success";
                const lowerStatus = c.status.toLowerCase();
                if (lowerStatus === "low" || lowerStatus === "unclear" || lowerStatus === "warning") {
                    badgeClass = "warning";
                } else if (lowerStatus === "leak" || lowerStatus === "tripped" || lowerStatus === "dirty" || (lowerStatus === "yes" && c.check_name.toLowerCase().includes("hotspot"))) {
                    badgeClass = "danger";
                }
                
                tr.innerHTML = `
                    <td><strong>${c.equipment_id}</strong></td>
                    <td>${c.check_name}</td>
                    <td><span class="badge ${badgeClass}">${c.status}</span></td>
                `;
                checkBody.appendChild(tr);
            });
        } else {
            checkBody.innerHTML = "<tr><td colspan='3'>No checks recorded for this day.</td></tr>";
        }
    } catch (e) {
        console.error("Error opening day detail modal:", e);
        closeDayModal();
    }
}

function closeDayModal() {
    const modal = document.getElementById("day-detail-modal");
    if (modal) {
        modal.style.display = "none";
    }
}

window.addEventListener("click", (e) => {
    const modal = document.getElementById("day-detail-modal");
    if (e.target === modal) {
        closeDayModal();
    }
});
