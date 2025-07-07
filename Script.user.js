// ==UserScript==
// @name         Nextiva Missed Call Collector - Google Sheets Integration
// @namespace    http://tampermonkey.net/
// @version      3.6
// @description  Collect missed call records from Nextiva with Google Sheets integration and performance optimizations
// @match        https://kwickpos.nextos.com/apps/nextiva-connect*
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      *.googleusercontent.com
// ==/UserScript==

class CallRecord {
    constructor(timestamp, contact, dataIndex, calledBack = false, isAnswered = false) {
        this.timestamp = timestamp;
        this.contact = contact;
        this.dataIndex = dataIndex;
        this.calledBack = calledBack;
        this.isAnswered = isAnswered;
    }
}

class PerformanceMonitor {
    constructor() {
        this.startTime = Date.now();
        this.metrics = {
            memoryUsage: [],
            processingTimes: [],
            domQueries: 0,
            networkRequests: 0,
            errors: 0
        };
        this.lastCleanup = Date.now();
        this.monitorInterval = null;
    }

    start() {
        this.monitorInterval = setInterval(() => {
            this.captureMetrics();
        }, 30000); // Every 30 seconds
    }

    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }

    captureMetrics() {
        const now = Date.now();
        const uptime = Math.round((now - this.startTime) / 1000);

        let memUsage = 'N/A';
        if (performance.memory) {
            memUsage = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
        }

        this.metrics.memoryUsage.push({
            timestamp: now,
            uptime: uptime,
            memory: memUsage
        });

        // Keep only last 10 measurements
        if (this.metrics.memoryUsage.length > 10) {
            this.metrics.memoryUsage.shift();
        }

        console.log(`[Performance] Uptime: ${uptime}s, Memory: ${memUsage}MB, Errors: ${this.metrics.errors}`);

        // Auto cleanup if memory is high
        if (memUsage !== 'N/A' && memUsage > 200) {
            console.warn(`[Performance] High memory usage: ${memUsage}MB - triggering cleanup`);
            if (window.nextiva_collector) {
                window.nextiva_collector.performanceCleanup();
            }

            // Clear old sent records (older than 6 hours)
            for (const [key, record] of this.sentRecords.entries()) {
                if (new Date(record.dateTime) < sixHoursAgo) {
                    this.sentRecords.delete(key);
                }
            }
        }
    }

    logError(error, context) {
        this.metrics.errors++;
        console.error(`[NextivaCollector] Error in ${context}:`, error);
    }

    recordProcessingTime(time) {
        this.metrics.processingTimes.push(time);
        if (this.metrics.processingTimes.length > 20) {
            this.metrics.processingTimes.shift();
        }
    }

    getReport() {
        const latest = this.metrics.memoryUsage[this.metrics.memoryUsage.length - 1];
        const avgProcessingTime = this.metrics.processingTimes.length > 0 ?
            Math.round(this.metrics.processingTimes.reduce((a, b) => a + b, 0) / this.metrics.processingTimes.length) : 0;

        return {
            uptime: latest ? latest.uptime : 0,
            memoryUsage: latest ? latest.memory : 'N/A',
            avgProcessingTime: avgProcessingTime,
            totalErrors: this.metrics.errors,
            domQueries: this.metrics.domQueries,
            networkRequests: this.metrics.networkRequests
        };
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

        // Real-time monitoring counters - only count new calls since monitoring started
        this.realTimeMissedCount = 0;
        this.monitorStartTime = null;

        // Google Sheets configuration
        this.googleSheetUrl = 'https://docs.google.com/spreadsheets/d/1MzDvA9RT22kLtU-2HT-OqaSy8LwN-ACF_FZfPGgE9zE/edit?gid=956231178#gid=956231178';
        this.googleScriptUrl = 'https://script.google.com/macros/s/AKfycbycj8DLsNt-6OlAVTJ78iOcThTWhaGUVGdVpY9WNYd--v3pwfEXxrzvu4_VEYyehTW1/exec';

        // Enhanced call tracking for answered calls
        this.recentCalls = new Map(); // key: phone number, value: array of call objects
        this.sentRecords = new Map(); // Track sent records by phone+timestamp for updates
        this.processedAnswers = new Set(); // Track processed answer events to prevent duplicates
        this.pendingRequests = new Set(); // Track pending network requests

        // Performance monitoring
        this.performanceMonitor = new PerformanceMonitor();
        this.cleanupInterval = null;

        this.loadFromLocalStorage();
        this.initPerformanceOptimizations();
    }

    initPerformanceOptimizations() {
        // Start performance monitoring
        this.performanceMonitor.start();

        // Regular cleanup every 5 minutes
        this.cleanupInterval = setInterval(() => {
            this.performanceCleanup();
        }, 5 * 60 * 1000);

        // Bind performance cleanup to window for external access
        window.nextiva_performance_cleanup = () => this.performanceCleanup();
    }

    performanceCleanup() {
        const before = this.getMemoryUsage();
        this.log('Performing performance cleanup...');

        try {
            // Clear old recent calls (older than 2 hours)
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            for (const [phoneNumber, calls] of this.recentCalls.entries()) {
                const recentCalls = calls.filter(call => call.time > twoHoursAgo);
                if (recentCalls.length === 0) {
                    this.recentCalls.delete(phoneNumber);
                } else {
                    this.recentCalls.set(phoneNumber, recentCalls.slice(-5)); // Keep max 5 per number
                }
            }

            // Keep only recent processed indexes (last 500)
            if (this.processedIndexes.size > 500) {
                const sortedIndexes = Array.from(this.processedIndexes).map(Number).sort((a, b) => b - a);
                this.processedIndexes = new Set(sortedIndexes.slice(0, 500).map(String));
            }

            // Keep only recent records (last 200 for real-time mode)
            if (this.isRealTimeMode && this.allRecords.length > 200) {
                this.allRecords = this.allRecords.slice(-200);
            }

            // Clear old processed answers (older than 6 hours)
            const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
            if (this.processedAnswers) {
                const validAnswers = new Set();
                for (const answerKey of this.processedAnswers) {
                    const parts = answerKey.split('_');
                    if (parts.length >= 2) {
                        const timestamp = parseInt(parts[parts.length - 1]);
                        if (!isNaN(timestamp) && new Date(timestamp) > sixHoursAgo) {
                            validAnswers.add(answerKey);
                        }
                    }
                }
                this.processedAnswers = validAnswers;
            }

            this.saveToLocalStorage();
            const after = this.getMemoryUsage();
            this.log(`Performance cleanup completed. Memory: ${before}MB -> ${after}MB`);

        } catch (error) {
            this.performanceMonitor.logError(error, 'performanceCleanup');
        }
    }

    getMemoryUsage() {
        return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : 0;
    }

    log(message, data = null) {
        if (this.debug) {
            console.log(`[Nextiva Collector] ${message}`, data || '');
        }
    }

    saveToLocalStorage() {
        try {
            const data = {
                records: this.allRecords.slice(-100).map(record => ({ // Keep only last 100
                    timestamp: record.timestamp.getTime(),
                    contact: record.contact,
                    dataIndex: record.dataIndex,
                    calledBack: record.calledBack,
                    isAnswered: record.isAnswered
                })),
                processedIndexes: Array.from(this.processedIndexes).slice(-300), // Keep only last 300
                realTimeMissedCount: this.realTimeMissedCount,
                monitorStartTime: this.monitorStartTime ? this.monitorStartTime.getTime() : null,
                sentRecords: Array.from(this.sentRecords.entries()).slice(-50), // Keep only last 50
                processedAnswers: Array.from(this.processedAnswers || []).slice(-50) // Keep only last 50
            };
            localStorage.setItem('nextiva_missed_calls', JSON.stringify(data));
        } catch (e) {
            this.log('Error saving to localStorage:', e);
            // If save fails, clear some data and try again
            this.performanceCleanup();
        }
    }

    loadFromLocalStorage() {
        try {
            const data = localStorage.getItem('nextiva_missed_calls');
            if (data) {
                const parsed = JSON.parse(data);
                this.allRecords = (parsed.records || []).map(record =>
                    new CallRecord(
                        new Date(record.timestamp),
                        record.contact,
                        record.dataIndex,
                        record.calledBack || false,
                        record.isAnswered || false
                    )
                );
                this.processedIndexes = new Set(parsed.processedIndexes || []);
                this.realTimeMissedCount = parsed.realTimeMissedCount || 0;
                this.monitorStartTime = parsed.monitorStartTime ? new Date(parsed.monitorStartTime) : null;
                this.sentRecords = new Map(parsed.sentRecords || []);
                this.processedAnswers = new Set(parsed.processedAnswers || []);
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
            this.realTimeMissedCount = 0;
            this.monitorStartTime = null;
            this.sentRecords.clear();
            // Don't clear processedAnswers here - only clear when starting real-time mode
            this.pendingRequests.clear();
            this.log('Cleared localStorage and pending requests');
        } catch (e) {
            this.log('Error clearing localStorage:', e);
        }
    }

    parseDateTime(text, lowerRowDates = []) {
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
            let hours = parseInt(yesterdayMatch[1]);
            const minutes = parseInt(yesterdayMatch[2]);
            const period = yesterdayMatch[3]?.toUpperCase();
            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;
            date.setDate(date.getDate() - 1);
            date.setHours(hours, minutes, 0, 0);

            if (lowerRowDates && lowerRowDates.some(d => d && d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear())) {
                date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
            }
            return date;
        }

        const parsed = Date.parse(text);
        if (!isNaN(parsed)) {
            return new Date(parsed);
        }

        return null;
    }

    parseAnyDateTime(text) {
        if (!text) return null;

        // Handle day of week format (Monday 3:45 PM, Tuesday 10:30 AM, etc.)
        const dayOfWeekMatch = text.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2}):(\d{2})\s*([AP]M)?/i);
        if (dayOfWeekMatch) {
            const [, dayName, hour, minute, period] = dayOfWeekMatch;
            const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const targetDayIndex = dayNames.indexOf(dayName.toLowerCase());

            if (targetDayIndex !== -1) {
                const now = new Date();
                const currentDayIndex = now.getDay();

                // Calculate how many days ago this was
                let daysAgo = currentDayIndex - targetDayIndex;
                if (daysAgo <= 0) {
                    daysAgo += 7; // It was last week
                }

                let hour24 = parseInt(hour);
                if (period) {
                    const periodUpper = period.toUpperCase();
                    if (periodUpper === 'PM' && hour24 !== 12) hour24 += 12;
                    if (periodUpper === 'AM' && hour24 === 12) hour24 = 0;
                }

                const targetDate = new Date(now);
                targetDate.setDate(targetDate.getDate() - daysAgo);
                targetDate.setHours(hour24, parseInt(minute), 0, 0);

                return targetDate;
            }
        }

        // Handle other date formats
        try {
            // MM/DD/YYYY format
            let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2}):(\d{2})\s*([AP]M)?/i);
            if (match) {
                const [, month, day, year, hour, minute, period] = match;
                let hour24 = parseInt(hour);
                if (period) {
                    const periodUpper = period.toUpperCase();
                    if (periodUpper === 'PM' && hour24 !== 12) hour24 += 12;
                    if (periodUpper === 'AM' && hour24 === 12) hour24 = 0;
                }
                return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), hour24, parseInt(minute));
            }

            // Try standard Date.parse as fallback
            const parsed = Date.parse(text);
            if (!isNaN(parsed)) {
                return new Date(parsed);
            }
        } catch (e) {
            // Silently ignore parsing errors
        }

        return null;
    }

    formatDateTimeForSheet(date) {
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        const year = date.getFullYear();
        let hours = date.getHours();
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours === 0 ? 12 : (hours > 12 ? hours - 12 : hours);
        const formattedHours = hours.toString().padStart(2, '0');

        return `${month}/${day}/${year} ${formattedHours}:${minutes} ${ampm}`;
    }

    extractPhoneNumber(contact) {
        const phoneMatch = contact.match(/\+?1?\s*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
        if (phoneMatch) {
            return phoneMatch[1] + phoneMatch[2] + phoneMatch[3];
        }
        return contact;
    }

    // Helper function to extract phone number from entire row content
    extractPhoneFromRow(row) {
        // First try to find the caller info element
        const callerInfoElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-callerInfo"]');
        if (callerInfoElement) {
            const phoneText = callerInfoElement.textContent.trim();
            const phoneMatch = phoneText.match(/\+?1?\s*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
            if (phoneMatch) {
                return `(${phoneMatch[1]})${phoneMatch[2]}-${phoneMatch[3]}`;
            }
        }

        // Fallback: try to extract from entire row text
        const allText = row.textContent;
        const phoneMatch = allText.match(/\+?1?\s*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
        if (phoneMatch) {
            return `(${phoneMatch[1]})${phoneMatch[2]}-${phoneMatch[3]}`;
        }
        return null;
    }

    // New function to separate contact name from phone number
    separateContactInfo(contact, row = null) {
        const phoneMatch = contact.match(/\+?1?\s*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
        if (phoneMatch) {
            const formattedPhone = `(${phoneMatch[1]})${phoneMatch[2]}-${phoneMatch[3]}`;
            // If the contact is just a phone number, return it as both display and notes
            if (contact.trim().replace(/[\s\-\(\)\+\.]/g, '').match(/^1?\d{10}$/)) {
                return {
                    displayNumber: formattedPhone,
                    contactName: null
                };
            }
            // If it's a name with phone number, separate them
            const nameWithoutPhone = contact.replace(/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/, '').trim();
            return {
                displayNumber: formattedPhone,
                contactName: nameWithoutPhone || null
            };
        }
        // If no phone number found in contact name, try to extract from entire row
        if (row) {
            const phoneFromRow = this.extractPhoneFromRow(row);
            if (phoneFromRow) {
                return {
                    displayNumber: phoneFromRow,
                    contactName: contact
                };
            }
        }

        // If still no phone number found, this shouldn't happen in normal operation
        // But we'll handle it gracefully
        return {
            displayNumber: contact,
            contactName: contact
        };
    }

    isActualMissedCall(phoneNumber, timestamp) {
        const oneHourAgo = new Date(timestamp.getTime() - 60 * 60 * 1000);
        const oneHourLater = new Date(timestamp.getTime() + 60 * 60 * 1000);
        const calls = this.recentCalls.get(phoneNumber) || [];

        for (const call of calls) {
            if (call.time > oneHourAgo && call.time < oneHourLater && call.isAnswered) {
                return 'No';
            }
        }

        return 'Yes';
    }

    updateRecentCalls(phoneNumber, timestamp, isMissed, isAnswered = false) {
        if (!this.recentCalls.has(phoneNumber)) {
            this.recentCalls.set(phoneNumber, []);
        }

        const calls = this.recentCalls.get(phoneNumber);
        calls.push({
            time: timestamp,
            isMissed: isMissed,
            isAnswered: isAnswered
        });

        // Keep only calls from the last 2 hours and limit array size
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const recentCalls = calls.filter(call => call.time > twoHoursAgo).slice(-10); // Max 10 calls per number
        this.recentCalls.set(phoneNumber, recentCalls);
    }

    async sendToGoogleSheets(record, isUpdate = false) {
        // Check if we're still in real-time mode before sending
        if (!this.isRealTimeMode) {
            this.log('Skipping Google Sheets request - real-time mode is off');
            return;
        }

        this.performanceMonitor.metrics.networkRequests++;

        const phoneNumber = this.extractPhoneNumber(record.contact);
        const actualMissedCall = this.isActualMissedCall(phoneNumber, record.timestamp);

        const contactInfo = this.separateContactInfo(record.contact);
        const data = {
            dateTime: this.formatDateTimeForSheet(record.timestamp),
            number: contactInfo.displayNumber,
            frequency: 1,
            actualMissedCall: actualMissedCall,
            isUpdate: isUpdate,
            phoneNumber: phoneNumber,
            source: isUpdate ? 'Real-time Update' : 'Real-time Monitor',
            notes: contactInfo.contactName
        };

        const recordKey = `${phoneNumber}_${record.timestamp.getTime()}`;
        this.sentRecords.set(recordKey, {
            dateTime: data.dateTime,
            number: data.number,
            actualMissedCall: actualMissedCall
        });

        try {
            const requestId = `${Date.now()}_${Math.random()}`;
            this.pendingRequests.add(requestId);

            GM_xmlhttpRequest({
                method: 'POST',
                url: this.googleScriptUrl,
                headers: {
                    'Content-Type': 'application/json',
                },
                data: JSON.stringify(data),
                timeout: 10000,
                anonymous: true, // Prevent sending credentials that might cause redirects
                onload: (response) => {
                    this.pendingRequests.delete(requestId);
                    if (!this.isRealTimeMode) {
                        this.log('Request completed but real-time mode is off - ignoring response');
                        return;
                    }
                    if (response.status === 200) {
                        this.log('Successfully sent to Google Sheets:', data);
                        try {
                            const result = JSON.parse(response.responseText);
                            if (result.action === 'frequency_updated') {
                                this.log('Frequency updated for existing record');
                            }
                        } catch (e) {
                            // Ignore parsing errors
                        }
                    } else {
                        this.log('Error sending to Google Sheets:', response);
                    }
                },
                onerror: (error) => {
                    this.pendingRequests.delete(requestId);
                    this.performanceMonitor.logError(error, 'sendToGoogleSheets');
                },
                ontimeout: () => {
                    this.pendingRequests.delete(requestId);
                    this.log('Timeout sending to Google Sheets');
                }
            });
        } catch (e) {
            this.performanceMonitor.logError(e, 'sendToGoogleSheets');
        }
    }

    async updateMissedCallsAfterAnswer(phoneNumber, answerTimestamp) {
        // Check if we're still in real-time mode before processing
        if (!this.isRealTimeMode) {
            this.log('Skipping missed call update - real-time mode is off');
            return 0;
        }

        const oneHourAgo = new Date(answerTimestamp.getTime() - 60 * 60 * 1000);
        const affectedRecords = [];

        // Simple deduplication: check if we've processed this exact call recently
        // Use minute-based key to prevent duplicate processing of the same answer event
        const answerMinute = new Date(answerTimestamp);
        answerMinute.setSeconds(0, 0); // Round to minute
        const answerKey = `${phoneNumber}_${answerMinute.getTime()}`;

        // Initialize processedAnswers if it doesn't exist
        if (!this.processedAnswers) {
            this.processedAnswers = new Set();
        }

        // Check if we've already processed this answer event within the same minute
        if (this.processedAnswers.has(answerKey)) {
            this.log('Answer event already processed within same minute:', answerKey);
            this.log('Current processedAnswers:', Array.from(this.processedAnswers));
            return 0;
        }

        this.log(`Looking for missed calls to update for phone ${phoneNumber} between ${oneHourAgo.toLocaleString()} and ${answerTimestamp.toLocaleString()}`);
        this.log(`Total records to check: ${this.allRecords.length}, Sent records: ${this.sentRecords.size}`);

        // Debug: Show all sent records for this phone number
        const phoneSentRecords = Array.from(this.sentRecords.keys()).filter(key => key.startsWith(phoneNumber));
        this.log(`Sent records for phone ${phoneNumber}:`, phoneSentRecords);

        // Debug: Show count of records being checked
        this.log(`Checking ${this.allRecords.length} records for phone ${phoneNumber}`);

        for (const record of this.allRecords) {
            const recordPhoneNumber = this.extractPhoneNumber(record.contact);
            if (recordPhoneNumber === phoneNumber &&
                record.timestamp > oneHourAgo &&
                record.timestamp < answerTimestamp) {

                const recordKey = `${phoneNumber}_${record.timestamp.getTime()}`;
                this.log(`Found potential record: ${record.contact} at ${record.timestamp.toLocaleString()}, sent: ${this.sentRecords.has(recordKey)}`);

                if (this.sentRecords.has(recordKey)) {
                    affectedRecords.push(record);
                }
            }
        }

        // Send updates for affected records (limit to prevent spam)
        for (const record of affectedRecords.slice(0, 3)) {
            this.log('Updating missed call status after answer:', {
                contact: record.contact,
                missedTime: record.timestamp.toLocaleString(),
                answeredTime: answerTimestamp.toLocaleString()
            });

            const contactInfo = this.separateContactInfo(record.contact);
            const updateData = {
                dateTime: this.formatDateTimeForSheet(record.timestamp), // Use the original missed call time to find the record
                number: contactInfo.displayNumber,
                phoneNumber: phoneNumber,
                actualMissedCall: 'No',
                isUpdate: true,
                source: `Call answered at ${this.formatDateTimeForSheet(answerTimestamp)}`,
                notes: contactInfo.contactName,
                answerTime: this.formatDateTimeForSheet(answerTimestamp) // Also send the answer time for logging
            };

            // Double-check we're still in real-time mode before sending
            if (!this.isRealTimeMode) {
                this.log('Real-time mode stopped during update process - aborting');
                break;
            }

            try {
                const requestId = `update_${Date.now()}_${Math.random()}`;
                this.pendingRequests.add(requestId);

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: this.googleScriptUrl,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    data: JSON.stringify(updateData),
                    timeout: 10000,
                    anonymous: true, // Prevent sending credentials that might cause redirects
                    onload: (response) => {
                        this.pendingRequests.delete(requestId);
                        if (!this.isRealTimeMode) {
                            this.log('Update request completed but real-time mode is off - ignoring response');
                            return;
                        }
                        if (response.status === 200) {
                            this.log('Successfully updated missed call status');
                        }
                    },
                    onerror: (error) => {
                        this.pendingRequests.delete(requestId);
                        this.performanceMonitor.logError(error, 'updateMissedCallsAfterAnswer');
                    },
                    ontimeout: () => {
                        this.pendingRequests.delete(requestId);
                        this.log('Timeout updating missed call status');
                    }
                });
            } catch (e) {
                this.performanceMonitor.logError(e, 'updateMissedCallsAfterAnswer');
            }
        }

        // Always mark as processed to prevent re-processing the same answered call
        this.processedAnswers.add(answerKey);

        if (affectedRecords.length > 0) {
            this.saveToLocalStorage();
            this.log(`Updated ${affectedRecords.length} missed call records`);
        } else {
            this.log(`No missed call records found to update for this answered call`);
        }

        return affectedRecords.length;
    }

    startRealTimeMode() {
        if (this.isRealTimeMode) {
            this.stopRealTimeMode(true);
        }
        this.isRealTimeMode = true;
        this.isCollecting = false;

        // Reset counters and perform cleanup
        this.realTimeMissedCount = 0;
        this.monitorStartTime = new Date();
        this.allRecords = [];
        this.processedIndexes.clear();
        this.recentCalls.clear();
        this.sentRecords.clear();
        this.processedAnswers.clear(); // Clear processed answers

        this.scrollToTop();
        this.setupRealTimeObserver();
        this.updateRealTimeCounter();
        this.log('Real-time mode started');
    }

    stopRealTimeMode(skipDownload = false) {
        if (!this.isRealTimeMode) return;

        this.log('Stopping real-time mode...');
        this.isRealTimeMode = false;

        // Clean up all observers and intervals immediately
        if (this.realTimeObserver) {
            this.realTimeObserver.disconnect();
            this.realTimeObserver = null;
            this.log('Real-time observer disconnected');
        }
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
            this.log('Real-time interval cleared');
        }
        if (this._topRecordCheckInterval) {
            clearInterval(this._topRecordCheckInterval);
            this._topRecordCheckInterval = null;
            this.log('Top record check interval cleared');
        }

        // Cancel any pending network requests
        if (this.pendingRequests && this.pendingRequests.size > 0) {
            this.log(`Cancelling ${this.pendingRequests.size} pending requests`);
            this.pendingRequests.clear();
        }

        if (!skipDownload) {
            this.clearLocalStorage();
            this.realTimeMissedCount = 0;
            this.monitorStartTime = null;
            this.updateRealTimeCounter();
        }

        this.log('Real-time mode stopped completely');
    }

    scrollToTop() {
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

        try {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;

            if (scrollContainer) {
                scrollContainer.scrollTop = 0;
                scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
            }
        } catch (e) {
            this.performanceMonitor.logError(e, 'scrollToTop');
        }
    }

    setupRealTimeObserver() {
        this.lastTopRecord = this.getCurrentTopRecord();

        const targetNode = document.body;

        this.realTimeObserver = new MutationObserver(async (mutations) => {
            let shouldCheck = false;
            for (const mutation of mutations) {
                if (
                    (mutation.type === 'childList' && mutation.addedNodes.length > 0) ||
                    mutation.type === 'characterData' ||
                    mutation.type === 'attributes'
                ) {
                    shouldCheck = true;
                    break;
                }
            }
            if (shouldCheck) {
                await this.checkForNewCalls();
            }
        });

        this.realTimeObserver.observe(targetNode, {
            childList: true,
            characterData: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-index']
        });

        this._topRecordCheckInterval && clearInterval(this._topRecordCheckInterval);
        this._topRecordCheckInterval = setInterval(async () => {
            const currentTop = this.getCurrentTopRecord();
            if (currentTop && this.hasTopRecordChanged(currentTop)) {
                await this.checkForNewCalls();
                this.lastTopRecord = this.getCurrentTopRecord();
            }
        }, 2000); // Increased interval for performance

        this.realTimeInterval = setInterval(async () => {
            await this.checkForNewCalls();
            this.lastTopRecord = this.getCurrentTopRecord();
        }, 5000); // Increased interval for performance
    }

    getCurrentTopRecord() {
        try {
            let topRow = document.querySelector('[data-index="0"] [data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');

            if (!topRow) {
                topRow = document.querySelector('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
            }

            if (!topRow) return null;

            const contactElement = topRow.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]');
            const timestampElement = topRow.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');

            if (!contactElement || !timestampElement) return null;

            return {
                contact: contactElement.textContent.trim(),
                timestamp: timestampElement.textContent.trim(),
                content: topRow.textContent.trim()
            };
        } catch (e) {
            return null;
        }
    }

    hasTopRecordChanged(currentTopRecord) {
        if (!this.lastTopRecord) return true;

        return (
            this.lastTopRecord.contact !== currentTopRecord.contact ||
            this.lastTopRecord.timestamp !== currentTopRecord.timestamp ||
            this.lastTopRecord.content !== currentTopRecord.content
        );
    }

    async checkForNewCalls() {
        const startTime = performance.now();

        try {
            this.performanceMonitor.metrics.domQueries++;

            // Only check the top/newest record
            const topRow = document.querySelector('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');

            if (!topRow) {
                return { newMissedFound: 0, answeredFound: 0 };
            }

            let newMissedFound = 0;
            let answeredFound = 0;

            // Process only the top row
            try {
                const parentElement = topRow.closest('[data-index]');
                if (!parentElement) {
                    return { newMissedFound: 0, answeredFound: 0 };
                }

                const dataIndex = parentElement.getAttribute('data-index');

                const isMissedCall = topRow.textContent.includes('Missed call');
                const isAnsweredCall = topRow.textContent.includes('Incoming call answered by') || topRow.textContent.includes('Incoming call');
                const timestampElement = topRow.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
                const contactElement = topRow.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]');

                if (!timestampElement || !contactElement) {
                    return { newMissedFound: 0, answeredFound: 0 };
                }

                let contact = contactElement.textContent.trim();
                const contactInfo = this.separateContactInfo(contact, topRow);

                // Debug logging for contact info separation (only for names with phone extraction)
                if (contactInfo.contactName && contactInfo.displayNumber !== contact) {
                    this.log('Contact name extracted:', {
                        originalContact: contact,
                        displayNumber: contactInfo.displayNumber,
                        contactName: contactInfo.contactName
                    });
                }

                // Use the display number for processing
                contact = contactInfo.displayNumber;

                const timestamp = this.parseDateTime(timestampElement.textContent, []);
                if (!timestamp) {
                    return { newMissedFound: 0, answeredFound: 0 };
                }

                // Only process calls that occurred after monitoring started
                if (this.monitorStartTime && timestamp <= this.monitorStartTime) {
                    return { newMissedFound: 0, answeredFound: 0 };
                }

                const phoneNumber = this.extractPhoneNumber(contact);

                // Update recent calls tracking for both missed and answered calls
                this.updateRecentCalls(phoneNumber, timestamp, isMissedCall, isAnsweredCall);

                // Handle answered calls - immediately update previous missed calls
                if (isAnsweredCall) {
                    this.log('Processing answered call immediately:', {
                        contact: contact,
                        phoneNumber: phoneNumber,
                        timestamp: timestamp.toLocaleString(),
                        timestampMs: timestamp.getTime()
                    });

                    // Update any previous missed calls from this number
                    const updatedCount = await this.updateMissedCallsAfterAnswer(phoneNumber, timestamp);
                    if (updatedCount > 0) {
                        answeredFound++;
                        this.log(`Updated ${updatedCount} previous missed calls for ${contact}`);
                    }
                    return { newMissedFound: 0, answeredFound };
                }

                // Handle missed calls - only count new ones since monitoring started
                if (isMissedCall) {
                    // Check if this record already exists based on contact + datetime
                    const exists = this.allRecords.some(record =>
                        record.contact === contact &&
                        record.timestamp.getTime() === timestamp.getTime()
                    );

                    if (!exists) {
                        const record = new CallRecord(timestamp, contact, dataIndex);
                        this.allRecords.push(record);
                        this.realTimeMissedCount++; // Increment real-time counter
                        newMissedFound++;

                        this.log('New missed call detected - sending immediately:', {
                            contact: record.contact,
                            timestamp: record.timestamp.toLocaleString(),
                            dataIndex: record.dataIndex
                        });

                        // Send to Google Sheets immediately
                        await this.sendToGoogleSheets(record);
                    }
                }
            } catch (error) {
                this.performanceMonitor.logError(error, 'checkForNewCalls.topRowProcessing');
                return { newMissedFound: 0, answeredFound: 0 };
            }

            // All calls are now processed immediately as they are detected

            if (newMissedFound > 0 || answeredFound > 0) {
                this.saveToLocalStorage();
                this.updateRealTimeCounter();

                if (answeredFound > 0) {
                    this.log(`Processed ${answeredFound} answered calls and updated related missed call records`);
                }
            }

            const processingTime = performance.now() - startTime;
            this.performanceMonitor.recordProcessingTime(processingTime);

            if (processingTime > 200) {
                console.warn(`[Performance] Slow processing: ${processingTime.toFixed(2)}ms`);
            }

            return { newMissedFound, answeredFound };
        } catch (error) {
            this.performanceMonitor.logError(error, 'checkForNewCalls');
            return { newMissedFound: 0, answeredFound: 0 };
        }
    }

    updateRealTimeCounter() {
        const counter = document.getElementById('missed-call-counter');
        if (counter) {
            counter.textContent = `Missed calls: ${this.realTimeMissedCount}`;
        }
    }

    openGoogleSheet() {
        window.open(this.googleSheetUrl, '_blank');
    }

    async collectRecords() {
        const rows = document.querySelectorAll('[data-testid="CommunicationsUI-Compact-View-Message-queue-card"]');
        this.lastKnownRowCount = rows.length;
        this.log(`Found ${rows.length} message rows`);
        let newRecordsCount = 0;
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

        const lowerRowDates = [];
        for (const row of rows) {
            const timestampElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
            if (timestampElement) {
                const timestamp = this.parseDateTime(timestampElement.textContent);
                if (timestamp) {
                    lowerRowDates.push(timestamp);
                }
            }
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

            const isMissedCall = row.textContent.includes('Missed call');
            const isAnsweredCall = row.textContent.includes('Incoming call answered by') || row.textContent.includes('Incoming call');

            if (!isMissedCall && !isAnsweredCall) {
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const timestampElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-timestamp"]');
            if (!timestampElement) continue;

            const contactElement = row.querySelector('[data-testid="CommunicationsUI-Compact-View-sender"]');
            if (!contactElement) continue;

            let contact = contactElement.textContent.trim();
            const contactInfo = this.separateContactInfo(contact, row);
            // Use the display number for processing
            contact = contactInfo.displayNumber;

            // For bulk collection mode, try to parse any date format, not just recent ones
            let timestamp = this.parseDateTime(timestampElement.textContent, lowerRowDates);
            if (!timestamp) {
                timestamp = this.parseAnyDateTime(timestampElement.textContent);
            }

            if (!timestamp) {
                this.log('Could not parse timestamp:', {
                    text: timestampElement.textContent,
                    contact: contact,
                    dataIndex: dataIndex
                });
                this.processedIndexes.add(dataIndex);
                continue;
            }

            const phoneNumber = this.extractPhoneNumber(contact);

            // Track all calls for answered call logic
            this.updateRecentCalls(phoneNumber, timestamp, isMissedCall, isAnsweredCall);

            // Only add missed calls to our records
            if (isMissedCall) {
                this.allRecords.push(new CallRecord(timestamp, contact, dataIndex));
                newRecordsCount++;

                this.log('Added record:', {
                    contact,
                    timestamp: timestamp.toLocaleString(),
                    dataIndex,
                    timestampText: timestampElement.textContent
                });
            }

            this.processedIndexes.add(dataIndex);
        }

        this.log('Collection statistics:', {
            totalRows: this.lastKnownRowCount,
            processedIndexes: this.processedIndexes.size,
            maxProcessedIndex: this.maxProcessedIndex,
            missingIndexes: missingIndexes
        });

        return {
            newRecordsCount,
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

        // Clean up URL
        setTimeout(() => {
            window.URL.revokeObjectURL(url);
        }, 100);
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
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 12px;
            border-radius: 6px;
            z-index: 9999;
            font-size: 13px;
            max-width: 300px;
            font-family: monospace;
        `;
        document.body.appendChild(statusText);

        let unchangedScrollCount = 0;
        let lastScrollHeight = scrollContainer.scrollHeight;
        let lastScrollTop = scrollContainer.scrollTop;
        let latestParsedDate = null;
        let oldestParsedDate = null;

        while (this.isCollecting) {
            const currentScrollTop = scrollContainer.scrollTop;
            const currentScrollHeight = scrollContainer.scrollHeight;

            // Collect records with performance monitoring
            const startTime = performance.now();
            const { newRecordsCount } = await this.collectRecords();
            const endTime = performance.now();

            // Update date tracking
            if (this.allRecords.length > 0) {
                const sortedRecords = this.allRecords.sort((a, b) => b.timestamp - a.timestamp);
                latestParsedDate = sortedRecords[0].timestamp;
                oldestParsedDate = sortedRecords[sortedRecords.length - 1].timestamp;
            }

            const progressPercent = currentScrollHeight > scrollContainer.clientHeight ?
                Math.round((currentScrollTop / (currentScrollHeight - scrollContainer.clientHeight)) * 100) : 100;

            const memUsage = this.getMemoryUsage();
            const dateRangeInfo = latestParsedDate && oldestParsedDate ?
                `${oldestParsedDate.toLocaleDateString()} to ${latestParsedDate.toLocaleDateString()}` : '';

            statusText.innerHTML = `
                <div>📊 Collecting all records...</div>
                <div>Total: ${this.allRecords.length} missed calls</div>
                <div>Processed: ${this.processedIndexes.size} records</div>
                <div>This batch: +${newRecordsCount} new records</div>
                <div>Date range: ${dateRangeInfo}</div>
                <div>Progress: ${progressPercent}%</div>
                <div>Memory: ${memUsage}MB</div>
                <div style="font-size: 11px; color: #ccc;">Processing: ${(endTime - startTime).toFixed(1)}ms</div>
            `;

            // Check stopping conditions
            const isAtBottom = currentScrollTop >= currentScrollHeight - scrollContainer.clientHeight - 50;
            const scrollDidntMove = Math.abs(currentScrollTop - lastScrollTop) < 20;
            const heightDidntChange = Math.abs(currentScrollHeight - lastScrollHeight) < 20;

            if (isAtBottom && scrollDidntMove && heightDidntChange) {
                unchangedScrollCount++;
                this.log(`Stopping condition check: isAtBottom=${isAtBottom}, scrollDidntMove=${scrollDidntMove}, heightDidntChange=${heightDidntChange}, unchangedCount=${unchangedScrollCount}`);

                if (unchangedScrollCount >= 3) {
                    this.log('Reached bottom of page - no more content to load');
                    break;
                }
            } else {
                unchangedScrollCount = 0;
            }

            // Scroll with performance optimization
            const scrollStep = Math.min(1200, scrollContainer.clientHeight * 1.2);
            const targetScrollTop = currentScrollTop + scrollStep;

            try {
                scrollContainer.scrollTo({
                    top: targetScrollTop,
                    behavior: 'instant' // Use instant for performance
                });
                await new Promise(resolve => setTimeout(resolve, 200)); // Reduced delay
            } catch (e) {
                scrollContainer.scrollTop = targetScrollTop;
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            lastScrollTop = currentScrollTop;
            lastScrollHeight = currentScrollHeight;

            // Shorter delay for better performance, but still allow page to load
            await new Promise(resolve => setTimeout(resolve, 400));

            // Trigger cleanup if processing is slow
            if (endTime - startTime > 500) {
                this.performanceCleanup();
            }
        }

        this.isCollecting = false;

        // Final collection pass
        await this.collectRecords();

        statusText.innerHTML = `
            <div style="color: #4CAF50; font-weight: bold;">✓ Collection Complete!</div>
            <div>Total collected: ${this.allRecords.length} missed call records</div>
            <div>From entire call history</div>
            <div>Processing avg: ${this.performanceMonitor.getReport().avgProcessingTime}ms</div>
        `;

        await this.downloadCSV();

        setTimeout(() => {
            statusText.remove();
        }, 5000);
    }

    showPerformanceReport() {
        const report = this.performanceMonitor.getReport();
        const message = `
Performance Report:
- Uptime: ${report.uptime} seconds
- Memory Usage: ${report.memoryUsage}MB
- Average Processing: ${report.avgProcessingTime}ms
- DOM Queries: ${report.domQueries}
- Network Requests: ${report.networkRequests}
- Total Errors: ${report.totalErrors}
- Records Found: ${this.realTimeMissedCount}
        `.trim();

        alert(message);
        console.log('[Performance Report]', this.performanceMonitor.metrics);
    }

    addButtons() {
        try {
            const collectButton = document.createElement('button');
            collectButton.textContent = 'Collect All Records';
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
            counter.textContent = `Missed calls: ${this.realTimeMissedCount}`;

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

            // Event handlers
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

            collectButton.onclick = async () => {
                if (this.isRealTimeMode || this.isCollecting) {
                    if (this.isCollecting) {
                        this.isCollecting = false;
                        collectButton.textContent = 'Collect All Records';
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

                collectButton.textContent = 'Collect All Records';
                realtimeButton.disabled = false;
                realtimeButton.style.opacity = '1';
            };

            viewButton.onclick = () => {
                this.openGoogleSheet();
            };

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

            document.body.appendChild(collectButton);
            document.body.appendChild(realtimeButton);
            document.body.appendChild(counter);
            document.body.appendChild(viewButton);

            if (this.realTimeMissedCount > 0) {
                counter.style.display = 'block';
                viewButton.style.display = 'block';
                this.updateRealTimeCounter();
            }

            this.log('Buttons added successfully');

        } catch (error) {
            this.log('Error adding buttons:', error);
        }
    }

    destroy() {
        this.log('Destroying NextivaCollector...');

        this.stopRealTimeMode();
        this.performanceMonitor.stop();

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        // Clear all data
        this.allRecords = [];
        this.processedIndexes.clear();
        this.recentCalls.clear();
        this.sentRecords.clear();
        this.processedAnswers.clear();

        this.log('NextivaCollector destroyed');
    }
}

window.nextiva_collector = null;

(function() {
    'use strict';
    console.log('Nextiva Collector script starting...');

    try {
        // Clean up any existing instance
        if (window.nextiva_collector) {
            window.nextiva_collector.destroy();
        }

        const collector = new NextivaCollector();
        window.nextiva_collector = collector;

        if (document.readyState === 'loading') {
            window.addEventListener('load', () => {
                setTimeout(() => {
                    console.log('Adding buttons after page load...');
                    collector.addButtons();
                }, 1000);
            });
        } else {
            setTimeout(() => {
                console.log('Adding buttons immediately...');
                collector.addButtons();
            }, 1000);
        }

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            collector.destroy();
        });

        console.log('Nextiva Collector initialized successfully');
    } catch (error) {
        console.error('Error initializing Nextiva Collector:', error);
    }
})();
