import cv2, numpy as np
img = cv2.imread('pd.jpg')[6:-6, 6:-6]          # drop the frame border
h, w = img.shape[:2]
s = 712 / 623                                     # display-coords -> original
P = lambda pts: (np.array(pts, np.float32) * s - 6).astype(np.int32)

mask = np.full((h, w), cv2.GC_BGD, np.uint8)
# Probable foreground: hull around sepals, petals and lip (traced from the photo).
hull = P([(33,372),(120,300),(175,262),(160,203),(265,238),(300,245),(330,215),(360,160),(420,95),(430,150),(345,245),(455,205),(462,222),(372,262),(470,300),(597,352),(560,372),(410,370),(408,420),(395,485),(345,560),(318,575),(270,535),(215,475),(210,385),(160,372),(60,378)])
cv2.fillPoly(mask, [hull], cv2.GC_PR_FGD)
# Sure foreground seeds: lip body, sepal cores, petals.
cv2.ellipse(mask, tuple(P([(310,440)])[0]), (int(55*s), int(75*s)), 0, 0, 360, cv2.GC_FGD, -1)
for a, b in [((70,365),(230,330)), ((400,320),(570,352)), ((190,215),(270,248)), ((355,238),(445,215)), ((345,190),(405,125))]:
    cv2.line(mask, tuple(P([a])[0]), tuple(P([b])[0]), cv2.GC_FGD, int(10*s))
cv2.circle(mask, tuple(P([(315,300)])[0]), int(22*s), cv2.GC_FGD, -1)   # column/"head"

# Refinements in cropped-image pixels: dorsal sepal and sepal tips are flower; the leaf under the left petal isn't.
C = lambda pts: np.array(pts, np.int32)
cv2.fillPoly(mask, [C([(340,240),(365,195),(415,135),(468,98),(488,112),(478,150),(430,200),(392,245)])], cv2.GC_PR_FGD)
cv2.line(mask, (380, 215), (465, 118), cv2.GC_FGD, 9)
cv2.fillPoly(mask, [C([(28,412),(40,388),(90,368),(100,395),(60,415)])], cv2.GC_PR_FGD)
cv2.fillPoly(mask, [C([(600,360),(650,372),(678,402),(640,412),(600,398)])], cv2.GC_PR_FGD)
cv2.line(mask, (55, 400), (110, 385), cv2.GC_FGD, 7)
cv2.line(mask, (600, 385), (655, 395), cv2.GC_FGD, 7)
bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
cv2.grabCut(img, mask, None, bgd, fgd, 8, cv2.GC_INIT_WITH_MASK)
m = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
# Drop dark saturated green (leaf/bud) above the lip; sepals are pale and petals orange, so they survive.
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
leaf = (hsv[..., 0] > 30) & (hsv[..., 0] < 60) & (hsv[..., 1] > 110) & (hsv[..., 2] < 190)
leaf[330:, :] = False
m[leaf] = 0
m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
# keep the largest component, fill pinholes, smooth the edge
n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
m = np.where(lab == 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA]), 255, 0).astype(np.uint8)
m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
cv2.imwrite('mask.png', m)
dbg = img.copy(); dbg[m == 0] = (dbg[m == 0] * 0.25).astype(np.uint8)
cv2.imwrite('debug.jpg', dbg)
print('fg fraction', (m > 0).mean().round(3))
