import cv2, numpy as np
from PIL import Image, ImageDraw, ImageEnhance

img = cv2.imread('pd.jpg')[6:-6, 6:-6]
m = cv2.imread('mask.png', 0)
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
# last green sliver left of the left petal
box = np.zeros_like(m, bool); box[240:315, 170:240] = True
m[box & (hsv[..., 0] > 28) & (hsv[..., 0] < 65) & (hsv[..., 1] > 70)] = 0
m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
n, lab, st, _ = cv2.connectedComponentsWithStats(m)
m = np.where(lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA]), 255, 0).astype(np.uint8)

# Trim the ragged tip of the dorsal sepal (it overlapped a bud) to a clean, rounded end.
yy, xx = np.mgrid[:m.shape[0], :m.shape[1]]
along = (xx - 380) * 0.66 + (yy - 215) * -0.75           # distance along the sepal's axis
region = (xx > 395) & (yy < 205)
m[region & (along > 96)] = 0
# round the new end
blob = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
m[region] = blob[region]
# Soft edge: erode a hair (kills green fringe), then feather.
m = cv2.erode(m, np.ones((3, 3), np.uint8))
a = cv2.GaussianBlur(m, (0, 0), 1.2).astype(np.float32) / 255

# The "edit": a little more contrast and saturation so it holds up small on black.
rgb = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
rgb = ImageEnhance.Contrast(rgb).enhance(1.08)
rgb = ImageEnhance.Color(rgb).enhance(1.12)
rgb = np.asarray(rgb).astype(np.float32)
out = (rgb * a[..., None]).clip(0, 255).astype(np.uint8)   # composite on #000

ys, xs = np.where(m > 0)
y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
flower = Image.fromarray(out[y0:y1 + 1, x0:x1 + 1])
alpha = Image.fromarray((a[y0:y1 + 1, x0:x1 + 1] * 255).astype(np.uint8))

def place(canvas_px, box_px, bg=(0, 0, 0, 255)):
    c = Image.new('RGBA', (canvas_px, canvas_px), bg)
    f = flower.copy(); al = alpha.copy()
    scale = box_px / max(f.size)
    size = (round(f.size[0] * scale), round(f.size[1] * scale))
    f = f.resize(size, Image.LANCZOS); al = al.resize(size, Image.LANCZOS)
    fl = f.convert('RGBA'); fl.putalpha(al)
    # optical centre: the lip is heavy, nudge up slightly
    c.alpha_composite(fl, ((canvas_px - size[0]) // 2, (canvas_px - size[1]) // 2 - canvas_px // 40))
    return c

# 3) transparent cut-out for in-app use (straight alpha, so no dark halo on light themes)
cut_rgba = Image.fromarray(np.dstack([rgb.clip(0, 255).astype(np.uint8), (a * 255).astype(np.uint8)])[y0:y1 + 1, x0:x1 + 1], 'RGBA')
w0, h0 = cut_rgba.size
cut_rgba.resize((256, round(256 * h0 / w0)), Image.LANCZOS).save('mark-256.png')   # tight crop, no padding
# 1) square logo on OLED black
place(1024, 860).save('logo-1024.png')
# 2) app icon: black rounded square on Apple's grid (824px body inside 1024, radius ~185)
body = place(824, 700)
mask = Image.new('L', (824, 824), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, 823, 823), radius=185, fill=255)
icon = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0)); body.putalpha(mask); icon.alpha_composite(body, (100, 100))
icon.save('icon-1024.png')
print('bbox', x0, y0, x1, y1)
