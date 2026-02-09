import altair as alt
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

from datetime import time
from scipy.stats import norm, gaussian_kde

# Params
s0 = 95_000
# k = 85_000
mu = 0.10
vol = 0.4
T = 14 / 365.25
dt = 1 / (365.25 * 24)
t = np.arange(T, 0, -dt)
cols = int(T / dt)
rows = 1_000  # number of sims

# Simulate spot & call prices
z = np.random.normal(0, 1, (rows, cols))
r = (mu - 0.5 * vol**2) * dt + z * vol * np.sqrt(dt)
s = s0 * np.exp(np.cumsum(r, axis=1))
final_prices = s[:, -1]

# d1 = (np.log(s / k) + 0.5 * vol**2 * t) / (vol * np.sqrt(t))
# d2 = d1 - vol * np.sqrt(t)
# delta = norm.cdf(d1)
# c = s * delta - k * norm.cdf(d2)

# d1 = (np.log(s0 / k) + 0.5 * vol**2 * T) / (vol * np.sqrt(T))
# d2 = d1 - vol * np.sqrt(T)
# c0 = s0 * norm.cdf(d1) - k * norm.cdf(d2)

# payoff = np.maximum(s - k, 0)
# option_pnl = payoff[:, -1] - c0
# stop_pnl = np.where(np.any(s < k, axis=1), k, s[:, -1]) - s0

# stopped = np.any(s < k, axis=1)
# itm = s[:, -1] > k

# Set up the plot for dark mode with formatted y-axis labels
plt.style.use("dark_background")
plt.rcParams.update({"font.size": 7, "font.family": "Arial"})

# Create a plot with subplots sharing the y-axis
fig, (ax1, ax2) = plt.subplots(
    1, 2, figsize=(16, 9), gridspec_kw={"width_ratios": [3, 1]}, sharey=True
)

# Colormap setup
cm = plt.cm.RdBu
normalize = plt.Normalize(vmin=min(final_prices), vmax=max(final_prices))

# Plot each simulation as an area between price paths with gradient colors based on final prices
for i in range(rows):
    color = cm(0.25 + 0.65 * normalize(final_prices[i]))
    ax1.fill_between(range(cols), s0, s[i], color=color, alpha=0.6)

# Plot histogram of final prices in the second subplot
n, bins, patches = ax2.hist(
    final_prices,
    bins=50,
    alpha=0.9,
    orientation="horizontal",
    edgecolor="whitesmoke",
    linewidth=0.1,
    density=False,
)

# Normalize bins for the color mapping
norm_bins = plt.Normalize(vmin=min(bins), vmax=max(bins))

# Apply gradient to the histogram bars based on bin values
for p, bin_start in zip(patches, bins):
    plt.setp(p, "facecolor", cm(0.25 + 0.65 * norm_bins(bin_start)))


for ax in [ax1, ax2]:
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)
    ax.spines["bottom"].set_visible(False)
    ax.tick_params(axis="both", which="both", length=0)

# Remove x-axis tick labels
ax1.set_xticklabels([])
ax1.set_yticklabels([])
ax2.set_xticklabels([])

# Limit the x-axis to remove any out-of-range labels
ax1.set_xlim(-20, cols - 1)

# Adjust layout to add padding between axis titles and figure edge
fig.tight_layout()

# Save
plt.savefig("gbm.png", dpi=300, bbox_inches="tight")
plt.savefig("gbm.svg", format="svg")

# Show the plot
plt.show()
