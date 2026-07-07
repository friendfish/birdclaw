#!/usr/bin/env python3
import sys
import os
import re
import subprocess
import argparse

def clean_markdown(text):
    # Remove markdown links: [text](url) -> text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    
    # Remove tweet reference parentheses: (tweet_1234, tweet_5678, ...) or (tweet_1234)
    text = re.sub(r'\(\s*tweet_\d+(?:\s*,\s*tweet_\d+)*\s*\)', '', text)
    
    # Remove headers, bullet points, bold/italic markers
    text = re.sub(r'^#+\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*[-*+]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'\*\*|__|\*|_', '', text)
    
    # Replace URL-like things with "链接"
    text = re.sub(r'https?://\S+', '相关链接', text)
    
    # Strip whitespace
    text = text.strip()
    return text

def get_today_digest(language):
    print(f"🔄 正在从 birdclaw 读取今日简报 (语言: {language})...")
    # Command to run birdclaw today
    try:
        # Run birdclaw command with full env from parent
        cmd = ["birdclaw", "today", "--language", language]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout
    except subprocess.CalledProcessError as e:
        print(f"❌ 运行 birdclaw today 失败: {e.stderr}", file=sys.stderr)
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="Birdclaw 语音播报工具 (MacOS 专属)")
    parser.add_argument("-l", "--language", choices=["zh-CN", "en"], default="zh-CN", help="播报语言 (zh-CN 或 en，默认 zh-CN)")
    parser.add_argument("-v", "--voice", help="自定义 macOS 系统语音名称 (默认中文 Sandy/Tingting, 英文 Samantha)")
    parser.add_argument("-o", "--output", help="输出音频文件路径 (例如: digest.m4a)")
    
    args = parser.parse_args()
    
    # Determine voice
    if args.voice:
        voice = args.voice
    else:
        if args.language == "zh-CN":
            # Sandy is a highly natural Siri neural voice on modern macOS
            voice = "Sandy"
        else:
            voice = "Samantha"
            
    # Fetch digest
    raw_text = get_today_digest(args.language)
    if not raw_text.strip():
        print("❌ 今日简报内容为空。")
        return
        
    cleaned_text = clean_markdown(raw_text)
    
    print(f"🔊 正在使用 [{voice}] 语音开始播报简报...")
    if args.output:
        out_path = os.path.abspath(args.output)
        print(f"💾 音频将同步保存至: {out_path}")
        # On macOS, say supports -o to save directly to m4a/aiff
        cmd = ["say", "-v", voice, "-o", out_path, cleaned_text]
    else:
        cmd = ["say", "-v", voice, cleaned_text]
        
    try:
        subprocess.run(cmd, check=True)
        print("✅ 播报完成！")
    except subprocess.CalledProcessError as e:
        print(f"❌ 语音播放失败: {e}", file=sys.stderr)

if __name__ == "__main__":
    main()
