MediaPlayer.dependencies.ScheduleController = function () {
    "use strict";

    var WAITING = "WAITING",
        READY = "READY",
        VALIDATING = "VALIDATING",
        LOADING = "LOADING",
        fragmentsToLoad,
        type,
        ready,
        fragmentModel,
        seeking,
        seekTarget,
        state = WAITING,
        isDynamic,
        currentRepresentation,
        initialPlayback = true,
        lastQuality = 0,

        playListMetrics = null,
        playListTraceMetrics = null,
        playListTraceMetricsClosed = true,

        setState = function(value) {
            var self = this;
            //self.debug.log("ScheduleController " + type + " setState to:" + value);
            state = value;
            // Notify the FragmentController about any state change to track the loading process of each active ScheduleController
            if (fragmentModel !== null) {
                self.fragmentController.onStateChange();
            }
        },

        clearPlayListTraceMetrics = function (endTime, stopreason) {
            var duration = 0,
                startTime = null;

            if (playListTraceMetricsClosed === false) {
                startTime = playListTraceMetrics.start;
                duration = endTime.getTime() - startTime.getTime();

                playListTraceMetrics.duration = duration;
                playListTraceMetrics.stopreason = stopreason;

                playListTraceMetricsClosed = true;
            }
        },

        doStart = function () {
            var currentTime;

            if (seeking === false) {
                currentTime = new Date();
                clearPlayListTraceMetrics(currentTime, MediaPlayer.vo.metrics.PlayList.Trace.USER_REQUEST_STOP_REASON);
                playListMetrics = this.metricsModel.addPlayList(type, currentTime, 0, MediaPlayer.vo.metrics.PlayList.INITIAL_PLAY_START_REASON);
                //mseSetTime = true;
            }

            this.debug.log("ScheduleController " + type + " start.");

            if (!ready) return;

            //this.debug.log("ScheduleController begin " + type + " validation");
            setState.call(this, READY);
            validate.call(this);
        },

        startOnReady = function(time) {
            getInitRequest.call(this, lastQuality);
            this.seek(time);
        },

        doSeek = function (time) {
            var currentTime,
                range = this.sourceBufferExt.getBufferRange(this.bufferController.getBuffer(), time);

            this.debug.log("ScheduleController " + type + " seek: " + time);
            seeking = true;
            seekTarget = time;
            currentTime = new Date();
            clearPlayListTraceMetrics(currentTime, MediaPlayer.vo.metrics.PlayList.Trace.USER_REQUEST_STOP_REASON);
            playListMetrics = this.metricsModel.addPlayList(type, currentTime, seekTarget, MediaPlayer.vo.metrics.PlayList.SEEK_START_REASON);

            if (!range && !initialPlayback) {
                this.fragmentController.cancelPendingRequestsForModel(fragmentModel);
            }

            doStart.call(this);
        },

        doStop = function () {
            if (state === WAITING) return;

            this.debug.log("ScheduleController " + type + " stop.");
            setState.call(this, WAITING);
            // cancel the requests that have already been created, but not loaded yet.
            this.fragmentController.cancelPendingRequestsForModel(fragmentModel);

            clearPlayListTraceMetrics(new Date(), MediaPlayer.vo.metrics.PlayList.Trace.USER_REQUEST_STOP_REASON);
        },

        loadInitialization = function () {

            if (initialPlayback) {
                this.debug.log("Marking a special seek for initial " + type + " playback.");

                // If we weren't already seeking, 'seek' to the beginning of the stream.
                if (!seeking) {
                    seeking = true;
                    seekTarget = 0;
                }

                initialPlayback = false;
            }
        },

        loadNextFragment = function () {
            var self = this,
                range,
                segmentTime,
                request;

            segmentTime = seeking ? seekTarget : self.indexHandler.getCurrentTime(currentRepresentation);
            seeking = false;
            range = self.sourceBufferExt.getBufferRange(self.bufferController.getBuffer(), segmentTime);

            if (range !== null) {
                segmentTime = range.end;
            }
            //self.debug.log("Loading the " + type + " fragment for time: " + segmentTime);
            request = self.indexHandler.getSegmentRequestForTime(currentRepresentation, segmentTime);

            return request;
        },

        onFragmentRequest = function (request) {
            var self = this,
                req;

            if (request !== null) {
                // If we have already loaded the given fragment ask for the next one. Otherwise prepare it to get loaded
                if (self.fragmentController.isFragmentLoadedOrPending(self, request)) {
                    if (request.action !== "complete") {
                        req = self.indexHandler.getNextSegmentRequest(currentRepresentation);
                        onFragmentRequest.call(self, req);
                    } else {
                        doStop.call(self);
                        setState.call(self, READY);
                    }
                } else {
                    //self.debug.log("Loading fragment: " + request.streamType + ":" + request.startTime);
                    self.fragmentController.prepareFragmentForLoading(self, request);
                    setState.call(self, READY);
                }
            } else {
                setState.call(self, READY);
            }
        },

        requestNewFragment = function() {
            var self = this,
                pendingRequests = self.fragmentController.getPendingRequests(self),
                loadingRequests = self.fragmentController.getLoadingRequests(self),
                ln = (pendingRequests ? pendingRequests.length : 0) + (loadingRequests ? loadingRequests.length : 0),
                request;

            if ((fragmentsToLoad - ln) > 0) {
                fragmentsToLoad--;
                request = loadNextFragment.call(self);
                onFragmentRequest.call(self, request);
            } else {

                if (state === VALIDATING) {
                    setState.call(self, READY);
                }

                finishValidation.call(self);
            }
        },

        getInitRequest = function(quality) {
            var self = this,
                request;

            request = self.indexHandler.getInitRequest(self.representationController.getRepresentationForQuality(quality));

            if (request !== null) {
                //self.debug.log("Loading initialization: " + request.streamType + ":" + request.startTime);
                //self.debug.log(request);
                self.fragmentController.prepareFragmentForLoading(self, request);
                setState.call(self, READY);
            }
        },

        getRequiredFragmentCount = function() {
            var self =this,
                playbackRate = self.playbackController.getPlaybackRate(),
                duration = self.playbackController.getPeriodDuration(),
                actualBufferedDuration = self.bufferController.getBufferLevel() / Math.max(playbackRate, 1),
                count,
                requiredBufferLength;

            requiredBufferLength = self.bufferExt.getRequiredBufferLength(isDynamic, duration);
            count = self.indexHandler.getSegmentCountForDuration(currentRepresentation, requiredBufferLength, actualBufferedDuration);

            return count;
        },

        validate = function () {
            var self = this;

            //self.debug.log("ScheduleController.validate() " + type + " | state: " + state);
            //self.debug.log(type + " Playback rate: " + self.videoModel.getElement().playbackRate);
            //self.debug.log(type + " Working time: " + currentTime);
            //self.debug.log(type + " Video time: " + currentVideoTime);
            //self.debug.log("Current " + type + " buffer length: " + bufferLevel);

            //mseSetTimeIfPossible.call(self);

            if (this.playbackController.isPaused() && (!this.scheduleWhilePaused || isDynamic)) return;

            if (state === READY) {
                setState.call(self, VALIDATING);
                self.abrController.getPlaybackQuality(type, self.streamProcessor.getData());
                fragmentsToLoad = getRequiredFragmentCount.call(self);
                loadInitialization.call(this);
                // We should request the media fragment w/o waiting for the next validate call
                // or until the initialization fragment has been loaded
                requestNewFragment.call(this);
            } else if (state === VALIDATING) {
                setState.call(self, READY);
            }
        },

        finishValidation = function () {
            var self = this;
            if (state === LOADING) {
                setState.call(self, READY);
            }
        },

        clearMetrics = function () {
            var self = this;

            if (type === null || type === "") {
                return;
            }

            self.metricsModel.clearCurrentMetricsForType(type);
        },

        onDataUpdateCompleted = function(sender, data, newRepresentation) {
            var self = this,
                time;

            time = self.indexHandler.getCurrentTime(currentRepresentation || newRepresentation);
            currentRepresentation = newRepresentation;
            addRepresentationSwitch.call(self);

            if (!isDynamic) {
                ready = true;
            }

            if (ready) {
                startOnReady.call(self, time);
            }
        },

        onStreamCompleted = function(sender, model /*, request*/) {
            if (model !== this.streamProcessor.getFragmentModel()) return;

            this.debug.log(type + " Stream is complete.");
            clearPlayListTraceMetrics(new Date(), MediaPlayer.vo.metrics.PlayList.Trace.END_OF_CONTENT_STOP_REASON);
            doStop.call(this);
        },

        onInitSegmentLoadingStart = function(sender, model/*, request*/) {
            var self = this;

            if (model !== self.streamProcessor.getFragmentModel()) return;

            setState.call(this, READY);
        },

        onMediaSegmentLoadingStart = function(sender, model/*, request*/) {
            var self = this,
                time;

            if (model !== self.streamProcessor.getFragmentModel()) return;

            time = self.fragmentController.getLoadingTime(self);
            setState.call(this, LOADING);

            setTimeout(function() {
                if (!self.fragmentController) return;
                setState.call(self, READY);
                requestNewFragment.call(self);
            }, time);
        },

        onBytesError = function (/*sender, request*/) {
            doStop.call(this);
        },

        onBytesAppended = function(/*sender*/) {
            var self = this,
                currentVideoTime = self.playbackController.getTime(),
                currentTime = new Date();

            if (playListTraceMetricsClosed === true && state !== WAITING && lastQuality !== -1) {
                playListTraceMetricsClosed = false;
                playListTraceMetrics = self.metricsModel.appendPlayListTrace(playListMetrics, currentRepresentation.id, null, currentTime, currentVideoTime, null, 1.0, null);
            }
        },

        onBytesRejected = function(sender, quality, index) {
            var req = fragmentModel.getExecutedRequestForQualityAndIndex(quality, index);
            // if request for an unappropriate quality has not been removed yet, do it now
            if (req) {
                fragmentModel.removeExecutedRequest(req);
                // if index is not undefined it means that this is a media segment, so we should
                // request the segment for the same time but with an appropriate quality
                // If this is init segment do nothing, because it will be requested in loadInitialization method
                if (index !== undefined) {
                    req = this.indexHandler.getSegmentRequestForTime(currentRepresentation, req.startTime);
                    onFragmentRequest.call(this, req);
                }
            }
        },

        onDataUpdateStarted = function(/*sender*/) {
            doStop.call(this);
        },

        onInitRequested = function(sender, quality) {
            getInitRequest.call(this, quality);
        },

        onBufferingCompleted = function (/*sender*/) {
            setState.call(this, READY);
        },

        onBufferLevelOutrun = function(/*sender*/) {
            fragmentsToLoad = 0;
        },

        onBufferCleared = function(sender, startTime, endTime) {
            // after the data has been removed from the buffer we should remove the requests from the list of
            // the executed requests for which playback time is inside the time interval that has been removed from the buffer
            this.fragmentController.removeExecutedRequestsBeforeTime(fragmentModel, endTime);
        },

        onBufferLevelStateChanged = function(sender, hasSufficientBuffer) {
            var self = this;

            if (!hasSufficientBuffer && !self.playbackController.isSeeking()) {
                self.debug.log("Stalling " + type + " Buffer: " + type);
                clearPlayListTraceMetrics(new Date(), MediaPlayer.vo.metrics.PlayList.Trace.REBUFFERING_REASON);
            }
        },

        onBufferLevelUpdated = function(sender, newBufferLevel) {
            var self = this;

            self.metricsModel.addBufferLevel(type, new Date(), newBufferLevel);
            validate.call(this);
        },

        onQuotaExceeded = function(/*sender, criticalBufferLevel*/) {
            doStop.call(this);
        },

        onQualityChanged = function(sender, typeValue, oldQuality, newQuality) {
            if (type !== typeValue) return;

            var self = this;

            if (lastQuality === newQuality) return;

            lastQuality = newQuality;

            currentRepresentation = self.representationController.getRepresentationForQuality(newQuality);

            if (currentRepresentation === null || currentRepresentation === undefined) {
                throw "Unexpected error!";
            }

            clearPlayListTraceMetrics(new Date(), MediaPlayer.vo.metrics.PlayList.Trace.REPRESENTATION_SWITCH_STOP_REASON);
            addRepresentationSwitch.call(self);
        },

        addRepresentationSwitch = function() {
            var now = new Date(),
                currentVideoTime = this.playbackController.getTime();

            this.metricsModel.addRepresentationSwitch(type, now, currentVideoTime, currentRepresentation.id);
        },

        onClosedCaptioningRequested = function(sender, quality) {
            var self = this;
            getInitRequest.call(self, quality);
            fragmentModel.executeCurrentRequest();
        },

        onPlaybackStarted = function(sender, startTime) {
            doSeek.call(this, startTime);
        },

        onPlaybackSeeking = function(sender, time) {
            doSeek.call(this, time);
        },

        onLiveEdgeFound = function(sender, liveEdgeTime, periodInfo) {
            // step back from a found live edge time to be able to buffer some data
            var self = this,
                fragmentDuration = currentRepresentation.segmentDuration || 0,
                startTime = Math.max((liveEdgeTime - self.bufferController.getMinBufferTime()), currentRepresentation.segmentAvailabilityRange.start),
                request,
                segmentStart;
            // get a request for a start time
            request = self.indexHandler.getSegmentRequestForTime(currentRepresentation, startTime);
            segmentStart = request.startTime;
            // set liveEdge to be in the middle of the segment time to avoid a possible gap between
            // currentTime and buffered.start(0)
            periodInfo.liveEdge = segmentStart + (fragmentDuration / 2);
            ready = true;
            startOnReady.call(self, segmentStart);
        };

    return {
        debug: undefined,
        system: undefined,
        metricsModel: undefined,
        bufferExt: undefined,
        scheduleWhilePaused: undefined,
        sourceBufferExt: undefined,
        abrController: undefined,
        eventList: undefined,
        notify: undefined,
        subscribe: undefined,
        unsubscribe: undefined,

        setup: function() {
            this.liveEdgeFound = onLiveEdgeFound;

            this.qualityChanged = onQualityChanged;

            this.dataUpdateStarted = onDataUpdateStarted;
            this.dataUpdateCompleted = onDataUpdateCompleted;

            this.initSegmentLoadingStart = onInitSegmentLoadingStart;
            this.mediaSegmentLoadingStart = onMediaSegmentLoadingStart;
            this.segmentLoadingFailed = onBytesError;
            this.streamCompleted = onStreamCompleted;

            this.bufferCleared = onBufferCleared;
            this.bufferingCompleted = onBufferingCompleted;
            this.bytesAppended = onBytesAppended;
            this.bytesRejected = onBytesRejected;
            this.bufferLevelOutrun = onBufferLevelOutrun;
            this.bufferLevelStateChanged = onBufferLevelStateChanged;
            this.bufferLevelUpdated = onBufferLevelUpdated;
            this.initRequested = onInitRequested;
            this.quotaExceeded = onQuotaExceeded;

            this.closedCaptioningRequested = onClosedCaptioningRequested;

            this.playbackStarted = onPlaybackStarted;
            this.playbackSeeking = onPlaybackSeeking;
        },

        initialize: function(typeValue, streamProcessor) {
            var self = this;

            type = typeValue;
            self.streamProcessor = streamProcessor;
            self.playbackController = streamProcessor.playbackController;
            self.fragmentController = streamProcessor.fragmentController;
            self.representationController = streamProcessor.representationController;
            self.liveEdgeFinder = streamProcessor.liveEdgeFinder;
            self.bufferController = streamProcessor.bufferController;
            self.indexHandler = streamProcessor.indexHandler;
            isDynamic = streamProcessor.isDynamic();
            fragmentModel = this.fragmentController.getModel(this);
        },

        getFragmentModel: function() {
            return fragmentModel;
        },

        reset: function() {
            var self = this;

            doStop.call(self);
            self.fragmentController.abortRequestsForModel(fragmentModel);
            self.fragmentController.detachModel(fragmentModel);
            clearMetrics.call(self);
        },

        isReady: function() {
            return state === READY;
        },

        start: doStart,
        seek: doSeek,
        stop: doStop
    };
};

MediaPlayer.dependencies.ScheduleController.prototype = {
    constructor: MediaPlayer.dependencies.ScheduleController
};