// ==UserScript==
// @name         Nextiva Missed Call Collector
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Collect missed call records from Nextiva with real-time monitoring
// @match        https://kwickpos.nextos.com/apps/nextiva-connect*
// @grant        none
// ==/UserScript==

class CallRecord {
    constructor(timestamp, contact, dataIndex, calledBack = false) {
        this.timestamp = timestamp;
        this.contact = contact;
        this.dataIndex = dataIndex;
        this.calledBack = calledBack;
    }
}

class NextivaCollector {
    constructor() {
        this.debug = true;
        this.isCollecting = false;
        this.isRealTimeMode = false;
        this.allRecords = [];
        this.processedIndexes = new Set();
        this.maxProcessedIndex = -1;
        this.lastKnownRowCount = 0;
        this.realTimeObserver = null;
        this.realTimeInterval = null;
        this.lastTopRecord = null;
        this.realTimeCount = 0;
        this.viewerWindow = null;
        this.viewerUpdateInterval = null;
        this.currentViewerTab = 'all'; // 新增：当前选中的tab
        this.loadFromLocalStorage();
    }

    log(message, data = null) {
        if (this.debug) {
            console.log(`[Nextiva Collector] ${message}`, data || '');
        }
    }

    saveToLocalStorage() {
        try {
            const data = {
                records: this.allRecords.map(record => ({
                    timestamp: record.timestamp.getTime(),
                    contact: record.contact,
                    dataIndex: record.dataIndex,
                    calledBack: record.calledBack
                })),
                processedIndexes: Array.from(this.processedIndexes),
                realTimeCount: this.realTimeCount
            };
            localStorage.setItem('nextiva_missed_calls', JSON.stringify(data));
            this.notifyViewerUpdate();
        } catch (e) {
            this.log('Error saving to localStorage:', e);
        }
    }

    loadFromLocalStorage() {
        try {
            const data = localStorage.getItem('nextiva_missed_calls');
            if (data) {
                const parsed = JSON.parse(data);
                this.allRecords = parsed.records.map(record =>
                    new CallRecord(
                        new Date(record.timestamp),
                        record.contact,
                        record.dataIndex,
                        record.calledBack || false
                    )
                );
                this.processedIndexes = new Set(parsed.processedIndexes || []);
                this.realTimeCount = parsed.realTimeCount || 0;
                this.log(`Loaded ${this.allRecords.length} records from localStorage`);
            }
        } catch (e) {
            this.log('Error loading from localStorage:', e);
        }
    }

    clearLocalStorage() {
        try {
            localStorage.removeItem('nextiva_missed_calls');
            this.allRecords = [];
            this.processedIndexes.clear();
            this.realTimeCount = 0;
            this.notifyViewerUpdate();
            this.log('Cleared localStorage');
        } catch (e) {
            this.log('Error clearing localStorage:', e);
        }
    }

    notifyViewerUpdate() {
        if (this.viewerWindow && this.viewerWindow.style.display !== 'none') {
            this.updateViewerContent();
        }
    }

    parseDateTime(text) {
        const now = new Date();
        let date = new Date();

        const timeOnlyMatch = text.match(/^(\d{1,2}):(\d{2})\s*([AP]M)?/i);
        if (timeOnlyMatch) {
            let hours = parseInt(timeOnlyMatch[1]);
            const minutes = parseInt(timeOnlyMatch[2]);
            const period = timeOnlyMatch[3]?.toUpperCase();

            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;

            date.setHours(hours, minutes, 0, 0);
            return date;
        }

        const yesterdayMatch = text.match(/Yesterday\s*(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
        if (yesterdayMatch) {
            date.setDate(date.getDate() - 1);

            let hours = parseInt(yesterdayMatch[1]);
            const minutes = parseInt(yesterdayMatch[2]);
            const period = yesterdayMatch[3]?.toUpperCase();

            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;

            date.setHours(hours, minutes, 0, 0);
            return date;
        }

        this.log('Date text does not match expected patterns:', text);
        return null;
    }

    isWithinTimeRange(dateText) {
        if (/^\d{1,2}:\d{2}\s*[AP]M?/i.test(dateText)) {
            return true;
        }

        if (/^Yesterday/i.test(dateText)) {
            return true;
        }

        return false;
    }

    async collectCurrentPageMissedCalls() {
        const rows = document.querySelectorAll('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
        let collectedCount = 0;

        this.log(`Collecting current page missed calls from ${rows.length} rows`);

        for (const row of rows) {
            const parentElement = row.closest('[data-index]');
            if (!parentElement) continue;

            const dataIndex = parentElement.getAttribute('data-index');

            if (this.processedIndexes.has(dataIndex)) continue;

            if (!row.textContent.includes('Missed call')) {
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const teammateElement = row.querySelector('.teammate, [class*="teammate"]');
            if (teammateElement) {
                this.log('Skipping teammate record');
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const timestampElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
            const contactElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]');

            if (!timestampElement || !contactElement) {
                this.processedIndexes.add(dataIndex);
                continue;
            }

            let contact = contactElement.textContent.trim();

            const phoneMatch = contact.match(/\+?1?\s*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
            if (phoneMatch) {
                contact = `(${phoneMatch[1]})${phoneMatch[2]}-${phoneMatch[3]}`;
            }

            const timestamp = this.parseDateTime(timestampElement.textContent);
            if (!timestamp) {
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const record = new CallRecord(timestamp, contact, dataIndex);
            this.allRecords.push(record);
            this.processedIndexes.add(dataIndex);
            collectedCount++;

            this.log('Collected existing missed call:', {
                contact: record.contact,
                timestamp: record.timestamp.toLocaleString(),
                dataIndex: record.dataIndex
            });
        }

        this.realTimeCount = this.allRecords.length;
        this.saveToLocalStorage();
        this.log(`Collected ${collectedCount} existing missed calls, total: ${this.realTimeCount}`);

        return collectedCount;
    }

    startRealTimeMode() {
        if (this.isRealTimeMode) {
            this.stopRealTimeMode(true); // true: do not download/clear data
        }
        this.isRealTimeMode = true;
        this.isCollecting = false;

        this.collectCurrentPageMissedCalls().then(() => {
            this.updateRealTimeCounter();
            this.updateViewerContent && this.updateViewerContent();
        });

        const possibleContainers = [
            '.infinite-scroll-component',
            '[role="grid"]',
            '.MuiBox-root > div',
            'main',
            '#root > div > div'
        ];

        let scrollContainer = null;
        for (const selector of possibleContainers) {
            const container = document.querySelector(selector);
            if (container && container.scrollHeight > container.clientHeight) {
                scrollContainer = container;
                break;
            }
        }

        if (!scrollContainer) {
            const allDivs = document.getElementsByTagName('div');
            let maxScrollHeight = 0;
            for (const div of allDivs) {
                if (div.scrollHeight > div.clientHeight && div.scrollHeight > maxScrollHeight) {
                    scrollContainer = div;
                    maxScrollHeight = div.scrollHeight;
                }
            }
        }

        window.scrollTo({ top: 0, behavior: 'smooth' });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;

        if (scrollContainer) {
            scrollContainer.scrollTop = 0;
            scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
        }

        this.setupRealTimeObserver();
        this.log && this.log('Real-time mode started');
    }

    stopRealTimeMode(skipDownload = false) {
        if (!this.isRealTimeMode) return;
        this.isRealTimeMode = false;

        if (this.realTimeObserver) {
            this.realTimeObserver.disconnect();
            this.realTimeObserver = null;
        }
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
        }
        if (this.viewerUpdateInterval) {
            clearInterval(this.viewerUpdateInterval);
            this.viewerUpdateInterval = null;
        }
        if (!skipDownload) {
            // Only clear data, do not auto-download (download is handled in viewer)
            this.clearLocalStorage();
            this.realTimeCount = 0;
            this.updateRealTimeCounter();
        }
        this.log && this.log('Real-time mode stopped');
    }

    setupRealTimeObserver() {
        this.lastTopRecord = this.getCurrentTopRecord();

        const targetNode = document.body;

        // Use MutationObserver to listen for childList, characterData, and subtree changes
        this.realTimeObserver = new MutationObserver(async (mutations) => {
            let shouldCheck = false;
            for (const mutation of mutations) {
                // Listen for childList (add/remove), characterData (text changes), and subtree
                if (
                    (mutation.type === 'childList' && mutation.addedNodes.length > 0) ||
                    mutation.type === 'characterData'
                ) {
                    shouldCheck = true;
                    break;
                }
            }
            if (shouldCheck) {
                await this.checkForNewMissedCalls();
            }
        });
        this.realTimeObserver.observe(targetNode, {
            childList: true,
            characterData: true,
            subtree: true
        });

        // Fallback: forced check if top record changes (every 2s)
        this._topRecordCheckInterval && clearInterval(this._topRecordCheckInterval);
        this._topRecordCheckInterval = setInterval(async () => {
            const currentTop = this.getCurrentTopRecord();
            if (currentTop && this.hasTopRecordChanged(currentTop)) {
                this.lastTopRecord = currentTop;
                await this.checkForNewMissedCalls();
            }
        }, 2000);

        // Still keep the periodic check (every 3s)
        this.realTimeInterval = setInterval(async () => {
            await this.checkForNewMissedCalls();
        }, 3000);

        this.viewerUpdateInterval = setInterval(() => {
            if (this.viewerWindow && this.viewerWindow.style.display !== 'none') {
                this.updateViewerContent();
            }
        }, 2000);
    }

    getCurrentTopRecord() {
        let topRow = document.querySelector('[data-index="0"] [data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');

        if (!topRow) {
            topRow = document.querySelector('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
        }

        if (!topRow) return null;

        const contactElement = topRow.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]');
        const timestampElement = topRow.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');

        if (!contactElement || !timestampElement) return null;

        const result = {
            contact: contactElement.textContent.trim(),
            timestamp: timestampElement.textContent.trim(),
            content: topRow.textContent.trim()
        };

        this.log && this.log('Current top record:', result);
        return result;
    }

    hasTopRecordChanged(currentTopRecord) {
        if (!this.lastTopRecord) return true;

        return (
            this.lastTopRecord.contact !== currentTopRecord.contact ||
            this.lastTopRecord.timestamp !== currentTopRecord.timestamp ||
            this.lastTopRecord.content !== currentTopRecord.content
        );
    }

    async checkForNewMissedCalls() {
        const rows = document.querySelectorAll('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
        const topRows = Array.from(rows).slice(0, 5);
        let newFound = 0;

        for (const row of topRows) {
            const parentElement = row.closest('[data-index]');
            if (!parentElement) continue;

            const dataIndex = parentElement.getAttribute('data-index');

            if (this.processedIndexes.has(dataIndex)) continue;

            if (!row.textContent.includes('Missed call')) {
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const teammateElement = row.querySelector('.teammate, [class*="teammate"]');
            if (teammateElement) {
                this.log && this.log('Skipping teammate record');
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const timestampElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
            const contactElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]');

            if (!timestampElement || !contactElement) {
                this.processedIndexes.add(dataIndex);
                continue;
            }

            let contact = contactElement.textContent.trim();

            const phoneMatch = contact.match(/\+?1?\s*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
            if (phoneMatch) {
                contact = `(${phoneMatch[1]})${phoneMatch[2]}-${phoneMatch[3]}`;
            }

            const timestamp = this.parseDateTime(timestampElement.textContent);
            if (!timestamp) {
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const record = new CallRecord(timestamp, contact, dataIndex);
            this.allRecords.push(record);
            this.processedIndexes.add(dataIndex);
            this.realTimeCount++;
            newFound++;
            this.updateRealTimeCounter();
            this.saveToLocalStorage();
            if (this.viewerWindow && this.viewerWindow.style.display !== 'none') {
                this.updateViewerContent();
            }
            this.log && this.log('New missed call detected:', {
                contact: record.contact,
                timestamp: record.timestamp.toLocaleString(),
                dataIndex: record.dataIndex
            });
        }
        return newFound;
    }

    getUncalledBackCount() {
        return this.allRecords.filter(record => !record.calledBack).length;
    }

    updateRealTimeCounter() {
        const counter = document.getElementById('missed-call-counter');
        if (counter) {
            const uncalledCount = this.getUncalledBackCount();
            counter.textContent = `Missed calls: ${uncalledCount}`;
        }
    }

    async downloadAndClearData() {
        if (this.allRecords.length === 0) {
            alert('No missed call records found.');
            this.clearLocalStorage();
            return;
        }

        const report = this.generateReport();
        const csv = [
            ['DateTime', 'Contact', 'Called Back'].join(','),
            ...report.map(row => [
                row.datetime,
                row.contact,
                row.calledBack ? 'Yes' : 'No'
            ].join(','))
        ].join('\n');

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);

        const now = new Date();
        const dateStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
        a.setAttribute('download', `Missed_call_records_realtime_${dateStr}.csv`);

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        this.clearLocalStorage();
        this.realTimeCount = 0;
        this.updateRealTimeCounter();
    }

    generateReport() {
        return this.allRecords.map(record => {
            const hour = record.timestamp.getHours();
            const ampm = hour >= 12 ? 'pm' : 'am';
            const hour12 = hour === 0 ? 12 : (hour > 12 ? hour - 12 : hour);
            const datetime = `${record.timestamp.getMonth() + 1}/${
            record.timestamp.getDate()}/${
            record.timestamp.getFullYear()} ${
            hour12}:${record.timestamp.getMinutes().toString().padStart(2, '0')} ${ampm}`;

            return {
                datetime: datetime,
                contact: record.contact,
                calledBack: record.calledBack
            };
        }).sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
    }

    showViewer() {
        if (this.viewerWindow && this.viewerWindow.style.display !== 'none') {
            this.viewerWindow.style.display = 'none';
            return;
        }

        if (!this.viewerWindow) {
            this.createViewer();
        }

        this.updateViewerContent();
        this.viewerWindow.style.display = 'block';
    }

    createViewer() {
        this.viewerWindow = document.createElement('div');
        this.viewerWindow.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 520px;
            height: 400px;
            background: white;
            border: 2px solid #333;
            border-radius: 8px;
            z-index: 10000;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            display: none;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            background: #f0f0f0;
            padding: 10px;
            border-bottom: 1px solid #ddd;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-radius: 6px 6px 0 0;
            cursor: move;
            user-select: none;
        `;

        const titleSection = document.createElement('div');
        titleSection.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
            pointer-events: none;
        `;

        const title = document.createElement('h3');
        title.textContent = 'Missed Calls Log';
        title.style.margin = '0';

        const downloadBtn = document.createElement('button');
        downloadBtn.textContent = '⬇ Download';
        downloadBtn.style.cssText = `
            background: #3498db;
            color: white;
            border: none;
            padding: 4px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            pointer-events: auto;
            transition: background-color 0.3s;
        `;
        downloadBtn.onmouseover = () => downloadBtn.style.backgroundColor = '#2980b9';
        downloadBtn.onmouseout = () => downloadBtn.style.backgroundColor = '#3498db';
        downloadBtn.onclick = (e) => {
            e.stopPropagation(); // 防止触发拖拽
            this.downloadViewerData();
        };

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            font-size: 20px;
            cursor: pointer;
            color: #666;
            pointer-events: auto;
        `;
        closeBtn.onclick = () => this.viewerWindow.style.display = 'none';

        titleSection.appendChild(title);
        titleSection.appendChild(downloadBtn);
        header.appendChild(titleSection);
        header.appendChild(closeBtn);

        // 新增：添加tabs导航
        const tabsNav = document.createElement('div');
        tabsNav.style.cssText = `
            background: #f8f9fa;
            padding: 0;
            border-bottom: 1px solid #ddd;
            display: flex;
            margin: 0;
        `;

        const tabs = [
            { id: 'all', label: 'All Missed Calls', color: '#6c757d' },
            { id: 'called_back', label: 'Called Back', color: '#28a745' },
            { id: 'pending', label: 'Pending', color: '#dc3545' }
        ];

        tabs.forEach((tab, tabIndex) => {
            const tabButton = document.createElement('button');
            tabButton.textContent = tab.label;
            tabButton.setAttribute('data-tab-id', tab.id); // 添加数据属性便于识别

            const isActive = this.currentViewerTab === tab.id;
            tabButton.style.cssText = `
                flex: 1;
                padding: 8px 12px;
                border: none;
                background: ${isActive ? tab.color : '#f8f9fa'};
                color: ${isActive ? 'white' : '#666'};
                cursor: pointer;
                font-size: 11px;
                transition: all 0.3s;
                border-bottom: 2px solid ${isActive ? tab.color : 'transparent'};
            `;

            tabButton.onmouseover = () => {
                if (this.currentViewerTab !== tab.id) {
                    tabButton.style.backgroundColor = '#e9ecef';
                }
            };

            tabButton.onmouseout = () => {
                if (this.currentViewerTab !== tab.id) {
                    tabButton.style.backgroundColor = '#f8f9fa';
                }
            };

            tabButton.onclick = () => {
                console.log(`Switching to tab: ${tab.id}`); // 调试日志
                this.currentViewerTab = tab.id;
                this.updateViewerContent();
            };

            tabsNav.appendChild(tabButton);
        });

        const content = document.createElement('div');
        content.id = 'viewer-content';
        content.style.cssText = `
            padding: 10px;
            height: calc(100% - 100px);
            overflow-y: auto;
            overflow-x: hidden;
            max-height: calc(100% - 100px);
        `;

        this.viewerWindow.appendChild(header);
        this.viewerWindow.appendChild(tabsNav);
        this.viewerWindow.appendChild(content);
        document.body.appendChild(this.viewerWindow);

        this.makeDraggable(this.viewerWindow, header);
    }

    makeDraggable(element, handle) {
        let isDragging = false;
        let dragStartX, dragStartY;
        let elementStartX, elementStartY;
        const dragSensitivity = 0.85;

        handle.addEventListener('mousedown', (e) => {
            if (e.target === handle || e.target.tagName === 'H3') {
                isDragging = true;
                element.style.cursor = 'grabbing';

                dragStartX = e.clientX;
                dragStartY = e.clientY;

                const rect = element.getBoundingClientRect();
                elementStartX = rect.left;
                elementStartY = rect.top;

                element.style.transform = 'none';
                element.style.left = elementStartX + 'px';
                element.style.top = elementStartY + 'px';

                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                e.preventDefault();

                const deltaX = (e.clientX - dragStartX) * dragSensitivity;
                const deltaY = (e.clientY - dragStartY) * dragSensitivity;

                const newX = elementStartX + deltaX;
                const newY = elementStartY + deltaY;

                const rect = element.getBoundingClientRect();
                const maxX = window.innerWidth - rect.width;
                const maxY = window.innerHeight - rect.height;

                const constrainedX = Math.max(0, Math.min(maxX, newX));
                const constrainedY = Math.max(0, Math.min(maxY, newY));

                element.style.left = constrainedX + 'px';
                element.style.top = constrainedY + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                element.style.cursor = 'default';
            }
        });

        handle.addEventListener('dblclick', () => {
            element.style.left = '50%';
            element.style.top = '50%';
            element.style.transform = 'translate(-50%, -50%)';
        });
    }

    // 新增：根据当前tab过滤数据
    getFilteredReport() {
        const fullReport = this.generateReport();

        switch (this.currentViewerTab) {
            case 'called_back':
                return fullReport.filter(row => row.calledBack);
            case 'pending':
                return fullReport.filter(row => !row.calledBack);
            case 'all':
            default:
                return fullReport;
        }
    }

    // 新增：更新tab按钮样式
    updateTabButtons() {
        if (!this.viewerWindow) return;

        const tabs = [
            { id: 'all', label: 'All Missed Calls', color: '#6c757d' },
            { id: 'called_back', label: 'Called Back', color: '#28a745' },
            { id: 'pending', label: 'Pending', color: '#dc3545' }
        ];

        // 通过data-tab-id属性查找按钮
        tabs.forEach(tab => {
            const button = this.viewerWindow.querySelector(`button[data-tab-id="${tab.id}"]`);
            if (!button) return;

            const isActive = this.currentViewerTab === tab.id;

            // 重新设置按钮样式
            button.style.cssText = `
                flex: 1;
                padding: 8px 12px;
                border: none;
                background: ${isActive ? tab.color : '#f8f9fa'};
                color: ${isActive ? 'white' : '#666'};
                cursor: pointer;
                font-size: 11px;
                transition: all 0.3s;
                border-bottom: 2px solid ${isActive ? tab.color : 'transparent'};
            `;

            // 重新绑定悬停事件
            button.onmouseover = () => {
                if (this.currentViewerTab !== tab.id) {
                    button.style.backgroundColor = '#e9ecef';
                }
            };

            button.onmouseout = () => {
                if (this.currentViewerTab !== tab.id) {
                    button.style.backgroundColor = '#f8f9fa';
                }
            };
        });
    }

    updateViewerContent() {
        const content = document.getElementById('viewer-content');
        if (!content) return;

        // 更新tab按钮样式
        this.updateTabButtons();

        // 获取过滤后的数据
        const report = this.getFilteredReport();
        const fullReport = this.generateReport(); // 用于统计

        if (report.length === 0) {
            let emptyMessage = '';
            switch (this.currentViewerTab) {
                case 'called_back':
                    emptyMessage = 'No called back records found.';
                    break;
                case 'pending':
                    emptyMessage = 'No pending calls found.';
                    break;
                default:
                    emptyMessage = 'No missed calls recorded.';
            }
            content.innerHTML = `<p style="text-align: center; color: #666; padding: 20px;">${emptyMessage}</p>`;
            return;
        }

        // 添加统计信息
        const statsDiv = document.createElement('div');
        const totalCalls = fullReport.length;
        const calledBackCount = fullReport.filter(r => r.calledBack).length;
        const pendingCount = totalCalls - calledBackCount;
        const currentCount = report.length;

        statsDiv.style.cssText = `
            background: #f8f9fa;
            padding: 8px;
            margin-bottom: 10px;
            border-radius: 4px;
            font-size: 11px;
            color: #555;
            border: 1px solid #e9ecef;
        `;

        let statsHtml = `<strong>Total:</strong> ${totalCalls} calls | `;
        statsHtml += `<strong style="color: #28a745;">Called Back:</strong> ${calledBackCount} | `;
        statsHtml += `<strong style="color: #dc3545;">Pending:</strong> ${pendingCount}`;

        // 如果不是显示全部，则显示当前过滤的数量
        if (this.currentViewerTab !== 'all') {
            statsHtml += ` | <strong>Showing:</strong> ${currentCount}`;
        }

        statsDiv.innerHTML = statsHtml;

        const table = document.createElement('table');
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            table-layout: fixed;
        `;

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr style="background: #f5f5f5; position: sticky; top: 0; z-index: 1;">
                <th style="border: 1px solid #ddd; padding: 8px; text-align: left; width: 35%;">DateTime</th>
                <th style="border: 1px solid #ddd; padding: 8px; text-align: left; width: 45%;">Contact</th>
                <th style="border: 1px solid #ddd; padding: 8px; text-align: center; width: 20%;">Called Back</th>
            </tr>
        `;

        const tbody = document.createElement('tbody');

        report.forEach((row, index) => {
            // 需要找到原始报告中的索引，以便正确处理checkbox回调
            const originalIndex = fullReport.findIndex(fullRow =>
                fullRow.datetime === row.datetime && fullRow.contact === row.contact
            );

            const tr = document.createElement('tr');

            // 修改：保持已回电的划线效果，但不改变在不同tab下的显示
            const rowStyle = row.calledBack ?
                'opacity: 0.5; text-decoration: line-through;' : '';

            tr.style.cssText = rowStyle + ' transition: background-color 0.2s;';

            // 添加悬停效果
            tr.onmouseover = () => {
                if (!row.calledBack) {
                    tr.style.backgroundColor = '#f9f9f9';
                }
            };
            tr.onmouseout = () => {
                if (!row.calledBack) {
                    tr.style.backgroundColor = '';
                }
            };

            tr.innerHTML = `
                <td style="border: 1px solid #ddd; padding: 8px; word-wrap: break-word;">${row.datetime}</td>
                <td style="border: 1px solid #ddd; padding: 8px; word-wrap: break-word;">${row.contact}</td>
                <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">
                    <input type="checkbox" ${row.calledBack ? 'checked' : ''}
                           onchange="window.nextiva_collector.updateCalledBack(${originalIndex}, this.checked)"
                           style="cursor: pointer;">
                </td>
            `;
            tbody.appendChild(tr);
        });

        table.appendChild(thead);
        table.appendChild(tbody);
        content.innerHTML = '';
        content.appendChild(statsDiv);
        content.appendChild(table);
    }

    // 新增：从viewer下载数据（不清空缓存）
    async downloadViewerData() {
        if (this.allRecords.length === 0) {
            alert('No missed call records to download.');
            return;
        }

        // 获取当前tab的过滤数据
        const report = this.getFilteredReport();

        if (report.length === 0) {
            alert('No records to download in current view.');
            return;
        }

        const csv = [
            ['DateTime', 'Contact', 'Called Back'].join(','),
            ...report.map(row => [
                row.datetime,
                row.contact,
                row.calledBack ? 'Yes' : 'No'
            ].join(','))
        ].join('\n');

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);

        const now = new Date();
        const dateStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
        const timeStr = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;

        // 根据当前tab添加文件名后缀
        let tabSuffix = '';
        switch (this.currentViewerTab) {
            case 'called_back':
                tabSuffix = '_called_back';
                break;
            case 'pending':
                tabSuffix = '_pending';
                break;
            default:
                tabSuffix = '_all';
        }

        a.setAttribute('download', `Missed_calls${tabSuffix}_${dateStr}_${timeStr}.csv`);

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        this.log(`Downloaded ${this.currentViewerTab} viewer data without clearing cache`);
    }

    updateCalledBack(index, checked) {
        const report = this.generateReport();
        if (index < report.length) {
            const reportItem = report[index];
            const recordToUpdate = this.allRecords.find(record => {
                const recordDatetime = `${record.timestamp.getMonth() + 1}/${
                    record.timestamp.getDate()}/${
                    record.timestamp.getFullYear()} ${
                    record.timestamp.getHours() === 0 ? 12 :
                    (record.timestamp.getHours() > 12 ? record.timestamp.getHours() - 12 : record.timestamp.getHours())}:${
                    record.timestamp.getMinutes().toString().padStart(2, '0')} ${
                    record.timestamp.getHours() >= 12 ? 'pm' : 'am'}`;

                return record.contact === reportItem.contact && recordDatetime === reportItem.datetime;
            });

            if (recordToUpdate) {
                recordToUpdate.calledBack = checked;
                this.saveToLocalStorage();
                this.updateRealTimeCounter();

                // 更新当前行样式
                const currentRow = event.target.closest('tr');
                if (currentRow) {
                    if (checked) {
                        currentRow.style.cssText = 'opacity: 0.5; text-decoration: line-through; transition: background-color 0.2s;';
                    } else {
                        currentRow.style.cssText = 'transition: background-color 0.2s;';
                    }
                }

                // 重新更新整个viewer内容以反映统计变化和可能的过滤变化
                setTimeout(() => {
                    this.updateViewerContent();
                }, 100);
            }
        }
    }

    // Legacy methods for one-time collection
    async collectRecords() {
        const rows = document.querySelectorAll('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
        this.lastKnownRowCount = rows.length;
        this.log(`Found ${rows.length} message rows`);
        let newRecordsCount = 0;
        let foundOldRecord = false;
        let missingIndexes = [];

        const currentIndexes = new Set();
        rows.forEach(row => {
            const parentElement = row.closest('[data-index]');
            if (parentElement) {
                const dataIndex = parseInt(parentElement.getAttribute('data-index'));
                currentIndexes.add(dataIndex);
            }
        });

        for (let i = 0; i <= Math.max(...currentIndexes); i++) {
            if (!currentIndexes.has(i) && !this.processedIndexes.has(i.toString())) {
                missingIndexes.push(i);
            }
        }

        if (missingIndexes.length > 0) {
            this.log('Missing indexes detected:', missingIndexes);
        }

        for (const row of rows) {
            const parentElement = row.closest('[data-index]');
            if (!parentElement) {
                this.log('Warning: Found row without data-index');
                continue;
            }

            const dataIndex = parentElement.getAttribute('data-index');
            const numericIndex = parseInt(dataIndex);

            this.maxProcessedIndex = Math.max(this.maxProcessedIndex, numericIndex);

            if (this.processedIndexes.has(dataIndex)) {
                continue;
            }

            if (!row.textContent.includes('Missed call')) {
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const teammateElement = row.querySelector('.teammate, [class*="teammate"]');
            if (teammateElement) {
                this.log('Skipping teammate record:', row.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]')?.textContent.trim());
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const timestampElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
            if (!timestampElement) continue;

            if (!this.isWithinTimeRange(timestampElement.textContent)) {
                foundOldRecord = true;
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const contactElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]');
            if (!contactElement) continue;

            let contact = contactElement.textContent.trim();

            const phoneMatch = contact.match(/\+?1?\s*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
            if (phoneMatch) {
                contact = `(${phoneMatch[1]})${phoneMatch[2]}-${phoneMatch[3]}`;
            }

            const timestamp = this.parseDateTime(timestampElement.textContent);
            if (!timestamp) continue;

            this.allRecords.push(new CallRecord(timestamp, contact, dataIndex));
            this.processedIndexes.add(dataIndex);
            newRecordsCount++;

            this.log('Added record:', {
                contact,
                timestamp: timestamp.toLocaleString(),
                dataIndex
            });
        }

        this.log('Collection statistics:', {
            totalRows: this.lastKnownRowCount,
            processedIndexes: this.processedIndexes.size,
            maxProcessedIndex: this.maxProcessedIndex,
            missingIndexes: missingIndexes
        });

        return {
            newRecordsCount,
            foundOldRecord,
            missingIndexes: missingIndexes.length > 0
        };
    }

    generateLegacyReport() {
        const sortedRecords = this.allRecords.sort((a, b) => b.timestamp - a.timestamp);
        const mergedRecords = new Map();

        for (const record of sortedRecords) {
            const hourTimestamp = new Date(record.timestamp);
            hourTimestamp.setMinutes(0, 0, 0);
            const key = `${record.contact}_${hourTimestamp.getTime()}`;

            if (mergedRecords.has(key)) {
                const existingRecord = mergedRecords.get(key);
                existingRecord.callsInHour += 1;
            } else {
                mergedRecords.set(key, {
                    timestamp: record.timestamp,
                    contact: record.contact,
                    callsInHour: 1
                });
            }
        }

        const report = Array.from(mergedRecords.values()).map(record => {
            const hour = record.timestamp.getHours();
            const ampm = hour >= 12 ? 'pm' : 'am';
            const hour12 = hour === 0 ? 12 : (hour > 12 ? hour - 12 : hour);
            const datetime = `${record.timestamp.getMonth() + 1}/${
            record.timestamp.getDate()}/${
            record.timestamp.getFullYear()} ${
            hour12}:${record.timestamp.getMinutes().toString().padStart(2, '0')} ${ampm}`;

            return {
                datetime: datetime,
                contact: record.contact,
                callsInHour: record.callsInHour
            };
        });

        return report.sort((a, b) => b.datetime.localeCompare(a.datetime));
    }

    async downloadCSV() {
        const report = this.generateLegacyReport();

        if (report.length === 0) {
            alert('No missed call records found.');
            return;
        }

        const csv = [
            ['DateTime', 'Contact', 'Calls in Hour'].join(','),
            ...report.map(row => [
                row.datetime,
                row.contact,
                row.callsInHour
            ].join(','))
        ].join('\n');

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);

        const now = new Date();
        const dateStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
        a.setAttribute('download', `Missed_call_records_${dateStr}.csv`);

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    async autoScrollAndCollect() {
        if (this.isCollecting) return;
        this.isCollecting = true;

        const possibleContainers = [
            '.infinite-scroll-component',
            '[role="grid"]',
            '.MuiBox-root > div',
            'main',
            '#root > div > div'
        ];

        let scrollContainer = null;
        for (const selector of possibleContainers) {
            const container = document.querySelector(selector);
            if (container && container.scrollHeight > container.clientHeight) {
                scrollContainer = container;
                break;
            }
        }

        if (!scrollContainer) {
            const allDivs = document.getElementsByTagName('div');
            let maxScrollHeight = 0;

            for (const div of allDivs) {
                if (div.scrollHeight > div.clientHeight && div.scrollHeight > maxScrollHeight) {
                    scrollContainer = div;
                    maxScrollHeight = div.scrollHeight;
                }
            }
        }

        if (!scrollContainer) {
            alert('Cannot find scrollable container. Please ensure the page is fully loaded.');
            this.isCollecting = false;
            return;
        }

        const statusText = document.createElement('div');
        statusText.style.cssText = `
            position: fixed;
            top: 60px;
            right: 10px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px;
            border-radius: 4px;
            z-index: 9999;
            font-size: 14px;
        `;
        document.body.appendChild(statusText);

        let lastScrollTop = 0;
        let unchangedScrollCount = 0;
        let foundAnyInTimeRange = false;

        while (this.isCollecting) {
            const initialRecordCount = this.allRecords.length;
            const startScrollTop = scrollContainer.scrollTop;
            foundAnyInTimeRange = false;

            const rows = document.querySelectorAll('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
            for (const row of rows) {
                const timestampElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
                if (timestampElement && this.isWithinTimeRange(timestampElement.textContent)) {
                    foundAnyInTimeRange = true;
                    break;
                }
            }

            const { newRecordsCount } = await this.collectRecords();

            statusText.textContent = `Collecting missed calls...
Collected ${this.allRecords.length} missed call records
Processed ${this.processedIndexes.size} records`;

            if (!foundAnyInTimeRange && scrollContainer.scrollTop === startScrollTop) {
                unchangedScrollCount++;
                if (unchangedScrollCount >= 3) {
                    this.log('No more scrolling possible and no recent records found, stopping collection');
                    break;
                }
            } else {
                unchangedScrollCount = 0;
            }

            const scrollStep = Math.min(500, scrollContainer.clientHeight * 0.6);
            const targetScrollTop = lastScrollTop + scrollStep;

            try {
                await new Promise((resolve) => {
                    scrollContainer.scrollTo({
                        top: targetScrollTop,
                        behavior: 'smooth'
                    });
                    setTimeout(resolve, 300);
                });

                lastScrollTop = scrollContainer.scrollTop;
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (e) {
                this.log('Scroll error:', e);
                scrollContainer.scrollTop = targetScrollTop;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        this.isCollecting = false;
        await this.collectRecords();

        statusText.textContent = `Collection complete!
Collected ${this.allRecords.length} missed call records`;

        await this.downloadCSV();

        setTimeout(() => {
            statusText.remove();
        }, 2000);
    }

    addButtons() {
        try {
            // One-time collection button
            const collectButton = document.createElement('button');
            collectButton.textContent = 'Collect Missed Calls';
            collectButton.style.cssText = `
                position: fixed;
                top: 10px;
                left: 45%;
                transform: translateX(-50%);
                z-index: 9999;
                padding: 8px 16px;
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                transition: background-color 0.3s;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            `;

            // Real-time monitoring button
            const realtimeButton = document.createElement('button');
            realtimeButton.textContent = 'Real-time Monitor';
            realtimeButton.style.cssText = `
                position: fixed;
                top: 10px;
                left: 55%;
                transform: translateX(-50%);
                z-index: 9999;
                padding: 8px 16px;
                background-color: #27ae60;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                transition: all 0.3s;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            `;

            // Counter display
            const counter = document.createElement('span');
            counter.id = 'missed-call-counter';
            counter.style.cssText = `
                position: fixed;
                top: 8px;
                left: 62%;
                transform: translateX(-50%);
                z-index: 9999;
                color: red;
                font-weight: bold;
                font-size: 13px;
                display: none;
            `;
            counter.textContent = `Missed calls: ${this.getUncalledBackCount()}`;

            // View button
            const viewButton = document.createElement('button');
            viewButton.textContent = 'View';
            viewButton.style.cssText = `
                position: fixed;
                top: 25px;
                left: 62%;
                transform: translateX(-50%);
                z-index: 9999;
                padding: 4px 8px;
                background-color: #95a5a6;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
                display: none;
            `;

            // Button hover effects
            realtimeButton.onmouseover = () => {
                if (!this.isRealTimeMode) {
                    realtimeButton.style.backgroundColor = '#229954';
                }
            };
            realtimeButton.onmouseout = () => {
                if (!this.isRealTimeMode) {
                    realtimeButton.style.backgroundColor = '#27ae60';
                }
            };

            collectButton.onmouseover = () => {
                collectButton.style.backgroundColor = '#2980b9';
            };
            collectButton.onmouseout = () => {
                collectButton.style.backgroundColor = '#3498db';
            };

            // Button click handlers
            realtimeButton.onclick = () => {
                if (this.isRealTimeMode) {
                    this.stopRealTimeMode();
                    realtimeButton.textContent = 'Real-time Monitor';
                    realtimeButton.style.backgroundColor = '#27ae60';
                    realtimeButton.style.animation = 'none';
                    counter.style.display = 'none';
                    viewButton.style.display = 'none';
                    collectButton.disabled = false;
                    collectButton.style.opacity = '1';
                } else {
                    this.startRealTimeMode();
                    realtimeButton.textContent = 'Stop Monitor';
                    realtimeButton.style.backgroundColor = '#e74c3c';
                    realtimeButton.style.animation = 'pulse 2s infinite';
                    counter.style.display = 'block';
                    viewButton.style.display = 'block';
                    this.updateRealTimeCounter();
                    collectButton.disabled = true;
                    collectButton.style.opacity = '0.5';
                }
            };

            // 添加双击强制刷新功能
            realtimeButton.ondblclick = () => {
                if (this.isRealTimeMode) {
                    this.log('Double-click detected: Force refresh check');
                    this.processedIndexes.clear(); // 清空已处理索引
                    this.checkForNewMissedCalls(); // 强制检查
                }
            };

            collectButton.onclick = async () => {
                if (this.isRealTimeMode || this.isCollecting) {
                    if (this.isCollecting) {
                        this.isCollecting = false;
                        collectButton.textContent = 'Collect Missed Calls';
                        realtimeButton.disabled = false;
                        realtimeButton.style.opacity = '1';
                    }
                    return;
                }

                this.allRecords = [];
                this.processedIndexes.clear();
                collectButton.textContent = 'Stop Collection';
                realtimeButton.disabled = true;
                realtimeButton.style.opacity = '0.5';

                await this.autoScrollAndCollect();

                collectButton.textContent = 'Collect Missed Calls';
                realtimeButton.disabled = false;
                realtimeButton.style.opacity = '1';
            };

            viewButton.onclick = () => {
                this.showViewer();
            };

            // Add CSS animation for pulse effect
            const style = document.createElement('style');
            style.textContent = `
                @keyframes pulse {
                    0% {
                        box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7);
                    }
                    70% {
                        box-shadow: 0 0 0 10px rgba(231, 76, 60, 0);
                    }
                    100% {
                        box-shadow: 0 0 0 0 rgba(231, 76, 60, 0);
                    }
                }
            `;
            document.head.appendChild(style);

            // Add buttons to page
            document.body.appendChild(realtimeButton);
            document.body.appendChild(collectButton);
            document.body.appendChild(counter);
            document.body.appendChild(viewButton);

            // Show counter and view button if there are existing records
            if (this.allRecords.length > 0) {
                counter.style.display = 'block';
                viewButton.style.display = 'block';
                this.updateRealTimeCounter();
            }

            this.log('Buttons added successfully');

        } catch (error) {
            this.log('Error adding buttons:', error);
        }
    }
}

// Make collector globally accessible for checkbox callbacks
window.nextiva_collector = null;

(function() {
    'use strict';
    console.log('Nextiva Collector script starting...');

    try {
        const collector = new NextivaCollector();
        window.nextiva_collector = collector;

        // Add buttons when page loads
        if (document.readyState === 'loading') {
            window.addEventListener('load', () => {
                setTimeout(() => {
                    console.log('Adding buttons after page load...');
                    collector.addButtons();
                }, 1000);
            });
        } else {
            // Document already loaded
            setTimeout(() => {
                console.log('Adding buttons immediately...');
                collector.addButtons();
            }, 1000);
        }

        console.log('Nextiva Collector initialized successfully');
    } catch (error) {
        console.error('Error initializing Nextiva Collector:', error);
    }
})();
