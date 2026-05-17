#!/usr/bin/env python3
"""CLI for audience engagement analysis."""

import argparse
import cv2
import sys
import logging
import time
from pathlib import Path
from engagement_analyzer import (
    AudienceMemberEngagementTracker,
    EngagementAggregator,
    EngagementAnalyzer,
    EngagementLogger,
)

logging.basicConfig(level=logging.WARNING, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="Analyze audience engagement from video")
    parser.add_argument(
        "--video",
        type=str,
        default="0",
        help="Video file path or camera index (default: 0 for webcam)"
    )
    parser.add_argument(
        "--output",
        type=str,
        default="engagement_logs",
        help="Output directory for engagement logs (default: engagement_logs)"
    )
    parser.add_argument(
        "--yolo-model",
        type=str,
        default="yolov8n.pt",
        help="YOLO model to use (default: yolov8n.pt)"
    )
    parser.add_argument(
        "--draw",
        action="store_true",
        help="Draw bounding boxes and labels on video"
    )
    parser.add_argument(
        "--display",
        action="store_true",
        help="Display video with overlays in real-time"
    )
    parser.add_argument(
        "--fps-limit",
        type=int,
        default=30,
        help="Target FPS (default: 30)"
    )
    parser.add_argument(
        "--bucket-seconds",
        type=float,
        default=5.0,
        help="Engagement summary bucket size in seconds (default: 5)"
    )
    parser.add_argument(
        "--log-mode",
        choices=("summary", "detail", "both"),
        default="summary",
        help="Which logs to write: compact summaries, detailed per-person frames, or both (default: summary)"
    )
    parser.add_argument(
        "--summary-format",
        choices=("production", "debug"),
        default="production",
        help="Summary JSON format: production emits only timestamp and score; debug includes diagnostics"
    )
    parser.add_argument(
        "--disable-member-tracking",
        action="store_true",
        help="Disable per-audience-member engagement files"
    )
    parser.add_argument(
        "--member-recognition-threshold",
        type=float,
        default=0.55,
        help="Face feature similarity threshold for matching returning members (default: 0.80)"
    )
    parser.add_argument(
        "--min-member-frames",
        type=int,
        default=10,
        help="Visible frames required before creating a new member file (default: 10)"
    )
    parser.add_argument(
        "--max-member-feature-prototypes",
        type=int,
        default=5,
        help="Maximum face-feature prototypes stored per member (default: 5)"
    )
    
    args = parser.parse_args()
    if args.bucket_seconds <= 0:
        parser.error("--bucket-seconds must be greater than 0")
    if not 0.0 <= args.member_recognition_threshold <= 1.0:
        parser.error("--member-recognition-threshold must be between 0.0 and 1.0")
    if args.min_member_frames <= 0:
        parser.error("--min-member-frames must be greater than 0")
    if args.max_member_feature_prototypes <= 0:
        parser.error("--max-member-feature-prototypes must be greater than 0")
    
    # Open video
    video_source = 0 if args.video == "0" else args.video
    try:
        video_source = int(video_source)
    except ValueError:
        pass
    
    cap = cv2.VideoCapture(video_source)
    if not cap.isOpened():
        logger.error(f"Failed to open video: {video_source}")
        return 1
    
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    logger.info(f"Video: {video_source}, {frame_width}x{frame_height} @ {fps} FPS")
    
    # Initialize analyzer and logger
    analyzer = EngagementAnalyzer(yolo_model=args.yolo_model)
    aggregator = EngagementAggregator(fps=fps, bucket_seconds=args.bucket_seconds)
    logger_obj = EngagementLogger(
        Path(args.output),
        log_details=args.log_mode in ("detail", "both"),
        log_summaries=args.log_mode in ("summary", "both"),
        summary_format=args.summary_format,
    )
    member_tracker = None
    if not args.disable_member_tracking:
        member_tracker = AudienceMemberEngagementTracker(
            Path(args.output),
            session_id=logger_obj.session_id,
            fps=fps,
            bucket_seconds=args.bucket_seconds,
            recognition_threshold=args.member_recognition_threshold,
            min_member_frames=args.min_member_frames,
            max_feature_prototypes=args.max_member_feature_prototypes,
        )
    
    if logger_obj.output_file is not None:
        logger.info(f"Detailed engagement logs will be saved to: {logger_obj.output_file}")
    if logger_obj.summary_output_file is not None:
        logger.info(f"Summary engagement logs will be saved to: {logger_obj.summary_output_file}")
    if member_tracker is not None:
        logger.info(f"Per-member engagement logs will be saved to: {member_tracker.output_dir}")
    logger.info("Press 'q' to quit")
    
    frame_count = 0
    started_at = time.monotonic()
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                logger.info("End of video")
                break
            
            # Process frame
            person_states = analyzer.process_frame(frame)
            elapsed_ms = int((time.monotonic() - started_at) * 1000)
            
            # Log results
            logger_obj.log_frame(frame_count, person_states)
            summary = aggregator.add_frame(frame_count, person_states, timestamp_ms=elapsed_ms)
            if summary is not None:
                logger_obj.log_summary(summary)
            if member_tracker is not None:
                member_tracker.add_frame(frame_count, frame, person_states, timestamp_ms=elapsed_ms)
            
            # Draw overlays if requested
            if args.draw or args.display:
                frame = draw_engagement_overlays(frame, person_states)
            
            # Display if requested
            if args.display:
                cv2.imshow("Engagement Analysis", frame)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    logger.info("User quit")
                    break
            
            frame_count += 1
            
            if frame_count % 100 == 0:
                logger.info(f"Processed {frame_count} frames, {len(person_states)} people detected")
    
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    
    finally:
        summary = aggregator.flush()
        if summary is not None:
            logger_obj.log_summary(summary)
        if member_tracker is not None:
            member_tracker.flush()
        cap.release()
        cv2.destroyAllWindows()
    
    logger.info(f"Processing complete. Total frames: {frame_count}")
    if logger_obj.output_file is not None:
        logger.info(f"Detailed logs saved to: {logger_obj.output_file}")
    if logger_obj.summary_output_file is not None:
        logger.info(f"Summary logs saved to: {logger_obj.summary_output_file}")
    if member_tracker is not None:
        logger.info(f"Per-member logs saved to: {member_tracker.output_dir}")
    
    return 0


def draw_engagement_overlays(frame, person_states):
    """Draw bounding boxes, states, and engagement scores on frame."""
    from engagement_analyzer import PersonState
    
    color_map = {
        "engaged": (0, 255, 0),        # Green
        "looking_down": (255, 200, 0), # Cyan/blue
        "on_phone": (0, 165, 255),     # Orange
        "asleep": (0, 0, 255),         # Red
        "distracted": (255, 0, 255),   # Magenta
        "absent": (128, 128, 128),     # Gray
        "neutral": (200, 200, 200),    # Light gray
    }
    
    for person in person_states:
        x, y, w, h = person.bbox
        color = color_map.get(person.state, (200, 200, 200))
        
        # Draw bounding box
        cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
        
        # Draw track ID, state, and score
        label = f"ID:{person.track_id} {person.state} ({person.engagement_score:.2f})"
        cv2.putText(
            frame,
            label,
            (x, y - 10),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            color,
            2
        )
        
        # Draw brief activity
        activity_label = person.likely_activity[:30]  # Truncate
        cv2.putText(
            frame,
            activity_label,
            (x, y + h + 20),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.4,
            color,
            1
        )
    
    return frame


if __name__ == "__main__":
    sys.exit(main())
