#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# --- Configuration ---
INITIAL_DIR=$(pwd)
TEMP_DIR="cllama_temp_build"
DIST_DIR="dist"

EXCLUDES=(
    "--exclude=$TEMP_DIR"
    "--exclude=$DIST_DIR"
    "--exclude=cllama.sh"
    "--exclude=.git*"
    "--exclude=doc/"
    # Local self-check scripts (node tools/*.test.mjs) — never shipped.
    "--exclude=tools/"
)

# Modes
chrome_mode=false
android_mode=false
firefox_mode=true  # Default
debug_mode=false

# --- Argument Parsing ---
for arg in "$@"; do
    case "$arg" in
        --chrome)
            chrome_mode=true
            firefox_mode=false
            ;;
        --android)
            android_mode=true
            firefox_mode=false
            ;;
        --debug)
            debug_mode=true
            ;;
        *)
            echo "Unknown argument: $arg"
            echo "Usage: $0 [--chrome|--android] [--debug]"
            exit 1
            ;;
    esac
done

# Android takes precedence over Chrome
if $chrome_mode && $android_mode; then
    chrome_mode=false
fi

# --- Preparation ---
mkdir -p "$DIST_DIR"

# Cleanup function to ensure TEMP_DIR is removed on exit
cleanup() {
    cd "$INITIAL_DIR" 2>/dev/null || true
    if [ -d "$TEMP_DIR" ]; then
        echo "Cleaning up temporary directory: $TEMP_DIR"
        rm -rf "$TEMP_DIR"
    fi
}

trap cleanup EXIT

# Fresh start for temp directory
rm -rf "$TEMP_DIR"
mkdir "$TEMP_DIR"

echo "Copying project files to temporary directory..."
rsync -a "${EXCLUDES[@]}" ./ "$TEMP_DIR/"

cd "$TEMP_DIR"

# --- 1. Platform-Specific File Handling ---
if $android_mode; then
    echo "Processing Android-specific files..."
    [ -f manifest.android.json ] && mv manifest.android.json manifest.json
    [ -f content_script.android.js ] && mv content_script.android.js content_script.js
    [ -f background.android.js ] && mv background.android.js background.js
    [ -f option/options.android.css ] && mv option/options.android.css option/options.css
    rm -f manifest.firefox.json
elif $chrome_mode; then
    echo "Chrome mode: using default manifest.json"
    rm -f manifest.firefox.json manifest.android.json
else
    echo "Firefox mode: applying Firefox manifest"
    if [ -f manifest.firefox.json ]; then
        rm -f manifest.json
        mv manifest.firefox.json manifest.json
    else
        echo "Warning: manifest.firefox.json not found"
    fi
    rm -f manifest.android.json
fi

# --- 2. Minification ---
if $debug_mode; then
    echo "Debug mode: skipping code compression."
else
    echo "Minifying JavaScript and CSS files..."
    
    # Check if minification tools are available
    if ! command -v uglifyjs &> /dev/null; then
        echo "Warning: uglifyjs not found. Skipping JS minification."
        echo "Install with: npm install -g uglify-js"
    fi
    
    if ! command -v uglifycss &> /dev/null; then
        echo "Warning: uglifycss not found. Skipping CSS minification."
        echo "Install with: npm install -g uglifycss"
    fi
    
    # Minify JS files in js directory and its subdirectories
    if [ -d "js" ] && command -v uglifyjs &> /dev/null; then
        find js -type f -name "*.js" -not -name "*.min.js" -print0 | while IFS= read -r -d '' file; do
            echo "Minifying $file..."
            uglifyjs "$file" -c -m -o "$file" || echo "Failed to minify $file"
        done
    fi
    
    # Minify top-level JS files
    if command -v uglifyjs &> /dev/null; then
        for file in background.js content_script.js; do
            if [ -f "$file" ]; then
                echo "Minifying $file..."
                uglifyjs "$file" -c -m -o "$file" || echo "Failed to minify $file"
            fi
        done
    fi
    
    # Minify CSS files
    if command -v uglifycss &> /dev/null; then
        if [ -d "css" ]; then
            find css -type f -name "*.css" -not -name "*.min.css" -print0 | while IFS= read -r -d '' file; do
                echo "Minifying $file..."
                uglifycss "$file" --output "$file" || echo "Failed to minify $file"
            done
        fi
        
        # Minify CSS in other directories
        for dir in chat insightify option popup viewer; do
            if [ -d "$dir" ]; then
                find "$dir" -type f -name "*.css" -not -name "*.min.css" -print0 | while IFS= read -r -d '' file; do
                    echo "Minifying $file..."
                    uglifycss "$file" --output "$file" || echo "Failed to minify $file"
                done
            fi
        done
    fi
    
    # Minify JS in other directories
    if command -v uglifyjs &> /dev/null; then
        for dir in chat insightify option popup viewer; do
            if [ -d "$dir" ]; then
                find "$dir" -type f -name "*.js" -not -name "*.min.js" -print0 | while IFS= read -r -d '' file; do
                    echo "Minifying $file..."
                    uglifyjs "$file" -c -m -o "$file" || echo "Failed to minify $file"
                done
            fi
        done
    fi
fi

# --- 3. Finalizing & Packaging ---
if $android_mode && $debug_mode; then
    OUTPUT_PATH="../$DIST_DIR/android"
    echo "Preparing Android build in $OUTPUT_PATH..."
    mkdir -p "$OUTPUT_PATH"
    rsync -a ./ "$OUTPUT_PATH/"
    echo "Android build ready at: $OUTPUT_PATH"
else
    echo "Packaging files..."
    if $android_mode; then
        PACKAGE_NAME="cllama_android.xpi"
    elif $chrome_mode; then
        PACKAGE_NAME="cllama_chrome.zip"
    else
        PACKAGE_NAME="cllama_firefox.xpi"
    fi
    
    if command -v zip &> /dev/null; then
        zip -r -FS "../$DIST_DIR/$PACKAGE_NAME" ./* || {
            echo "Error: Failed to create package"
            exit 1
        }
        echo "Extension packaged at: $DIST_DIR/$PACKAGE_NAME"
    else
        echo "Error: zip command not found"
        exit 1
    fi
fi


echo "Build complete!"